import { PublicKey, type Keypair } from '@solana/web3.js';
import { ColdAuditor } from './analysis/coldAudit.js';
import { HotFilter } from './analysis/hotFilter.js';
import { ReputationStore } from './analysis/reputation.js';
import { score } from './analysis/scorer.js';
import { BlockhashCache } from './chain/blockhash.js';
import { FeeOracle } from './chain/fees.js';
import { JitoClient } from './chain/jito.js';
import { PROGRAMS } from './chain/programs.js';
import { RpcPool } from './chain/rpcPool.js';
import { Sender } from './chain/sender.js';
import { loadKeypair, paperKeypair } from './chain/wallet.js';
import type { Config } from './config.js';
import { bus } from './core/bus.js';
import { makeLogger } from './core/logger.js';
import { metrics } from './core/metrics.js';
import { sol, truncMint } from './core/util.js';
import { Dispatcher } from './detect/dispatcher.js';
import { PumpFunDetector } from './detect/pumpfun.js';
import { RaydiumDetector } from './detect/raydium.js';
import { PumpFunExecutor } from './exec/executor.js';
import { PaperExecutor } from './exec/paper.js';
import type { PumpLayoutVersion } from './exec/pumpfun/ix.js';
import { probePumpLayout, verifyProgram } from './exec/pumpfun/probe.js';
import { PositionManager } from './position/manager.js';
import { PositionStore } from './position/store.js';
import { RiskEngine } from './risk/riskEngine.js';
import type { Executor, LaunchEvent } from './types.js';
import { Dashboard } from './ui/dashboard.js';

const log = makeLogger('runtime');

export interface RuntimeOptions {
  /** Detect and score, but never send an order. Used by `watch`. */
  readonly observeOnly?: boolean;
}

/**
 * Wires every component together and owns the launch→decision→order pipeline.
 */
export class Runtime {
  readonly pool: RpcPool;
  readonly sendPool: RpcPool;
  private readonly signer: Keypair;
  private readonly owner: PublicKey;
  private readonly jito: JitoClient;
  private readonly sender: Sender;
  private readonly blockhash: BlockhashCache;
  private readonly fees: FeeOracle;
  private readonly reputation: ReputationStore;
  private readonly hotFilter: HotFilter;
  private readonly auditor: ColdAuditor;
  private readonly risk: RiskEngine;
  private readonly store: PositionStore;
  private readonly dispatcher: Dispatcher;
  private readonly dashboard: Dashboard;

  private executor!: Executor;
  private manager!: PositionManager;
  private pumpDetector: PumpFunDetector | null = null;
  private rayDetector: RaydiumDetector | null = null;
  private layout: PumpLayoutVersion = 'creator-vault';
  private inFlight = 0;
  private balanceTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly cfg: Config,
    private readonly opts: RuntimeOptions = {},
  ) {
    this.pool = new RpcPool(cfg.RPC_HTTP, cfg.RPC_WS);
    this.sendPool =
      cfg.SEND_RPC_HTTP.length > 0 ? new RpcPool(cfg.SEND_RPC_HTTP) : this.pool;

    this.signer = cfg.WALLET_SECRET ? loadKeypair(cfg.WALLET_SECRET) : paperKeypair();
    this.owner = this.signer.publicKey;

    this.jito = new JitoClient(cfg.JITO_ENABLED ? cfg.JITO_ENDPOINTS : []);
    this.sender = new Sender(this.pool, this.sendPool, this.jito);
    this.blockhash = new BlockhashCache(this.pool);
    this.fees = new FeeOracle(this.pool, cfg.PRIORITY_FEE_MICROLAMPORTS, cfg.PRIORITY_FEE_MAX_MICROLAMPORTS);
    this.reputation = new ReputationStore(cfg.STATE_DIR);
    this.hotFilter = new HotFilter(this.pool, cfg, this.reputation);
    this.auditor = new ColdAuditor(this.pool);
    this.risk = new RiskEngine(cfg);
    this.store = new PositionStore(cfg.STATE_DIR);
    this.dispatcher = new Dispatcher((ev) => void this.onLaunch(ev));
    this.dashboard = new Dashboard(this.store, this.risk, this.pool, this.fees);
  }

  get wallet(): PublicKey {
    return this.owner;
  }

  async start(): Promise<void> {
    log.info('starting', {
      mode: this.cfg.MODE,
      observeOnly: this.opts.observeOnly === true,
      wallet: this.owner.toBase58(),
      rpcs: this.pool.size,
      sendRpcs: this.sendPool.size,
      jito: this.cfg.JITO_ENABLED,
    });

    // Fail loudly here rather than "running" against endpoints that answer
    // nothing: a sniper with no feed is indistinguishable from a quiet market.
    const slot = await this.pool
      .race('getSlot', (c) => c.getSlot('processed'), 8_000)
      .catch((err: unknown) => {
        throw new Error(
          `no RPC endpoint answered: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    log.info('chain reachable', { slot });

    if (this.cfg.MODE === 'live' && !this.opts.observeOnly) {
      const program = await verifyProgram(this.pool);
      if (!program.executable) throw new Error('pump.fun program account is not executable');
      log.info('program verified', program);
    }

    await this.blockhash.start();
    await this.fees.start([PROGRAMS.pumpFun]);

    this.executor =
      this.cfg.MODE === 'live' && !this.opts.observeOnly
        ? new PumpFunExecutor(
            {
              pool: this.pool,
              sender: this.sender,
              blockhash: this.blockhash,
              fees: this.fees,
              cfg: this.cfg,
              layout: this.layout,
            },
            this.signer,
          )
        : new PaperExecutor(this.pool, this.cfg);

    this.manager = new PositionManager(
      this.cfg,
      this.store,
      this.executor,
      this.auditor,
      this.risk,
      this.reputation,
      this.owner,
    );
    this.manager.resumeAll();

    await this.refreshBalance();
    this.balanceTimer = setInterval(() => void this.refreshBalance(), 30_000);
    this.balanceTimer.unref?.();

    if (this.cfg.WATCH_PUMPFUN) {
      this.pumpDetector = new PumpFunDetector(this.pool, (ev) => this.dispatcher.submit(ev));
      await this.pumpDetector.start();
    }
    if (this.cfg.WATCH_RAYDIUM) {
      this.rayDetector = new RaydiumDetector(this.pool, (ev) => this.dispatcher.submit(ev));
      await this.rayDetector.start();
    }
    if (!this.pumpDetector && !this.rayDetector) {
      throw new Error('no detectors enabled: set WATCH_PUMPFUN or WATCH_RAYDIUM');
    }

    this.dashboard.start();
    bus.on('risk:halt', ({ reason }) => void this.manager.liquidateAll(`halt: ${reason}`));
    log.info('running — press Ctrl+C to stop');
  }

  /**
   * The decision pipeline for one launch.
   *
   * Every stage can reject, and rejections are the common case by design: a
   * good session skips well over ninety percent of what it sees.
   */
  private async onLaunch(ev: LaunchEvent): Promise<void> {
    const tag = { mint: truncMint(ev.mint), venue: ev.venue, sym: ev.metadata?.symbol ?? '?' };

    // Raydium launches are detected for visibility but not traded natively:
    // the bonding-curve fast path is pump.fun only.
    if (ev.venue !== 'pumpfun') {
      log.debug('observed non-pumpfun launch', tag);
      metrics.inc('pipeline.unsupported_venue');
      return;
    }

    if (this.inFlight >= this.cfg.MAX_CONCURRENT_POSITIONS) {
      metrics.inc('pipeline.busy');
      return;
    }
    this.inFlight++;
    try {
      if (ev.creator) this.reputation.noteLaunch(ev.creator);

      const hot = await this.hotFilter.evaluate(ev);
      const verdict = score(hot.signals, this.cfg.MIN_SCORE);

      if (verdict.action === 'skip') {
        metrics.inc('pipeline.skipped');
        log.debug('skip', { ...tag, score: verdict.score, why: verdict.reasons[0] });
        return;
      }

      const decision = this.risk.approve(verdict.score, this.manager.openCount);
      if (!decision.allowed) {
        metrics.inc('pipeline.risk_blocked');
        log.info('risk blocked', { ...tag, score: verdict.score, why: decision.reason });
        return;
      }

      if (this.opts.observeOnly) {
        metrics.inc('pipeline.would_enter');
        log.info('WOULD ENTER', {
          ...tag,
          score: verdict.score,
          size: sol(decision.lamports),
          filterMs: hot.elapsedMs,
          why: verdict.reasons.join(' | '),
        });
        return;
      }

      log.info('ENTER', {
        ...tag,
        score: verdict.score,
        size: sol(decision.lamports),
        filterMs: hot.elapsedMs,
        sizing: decision.note,
      });
      // The reserves the filter already paid for are handed to the executor so
      // the entry does not re-read the curve.
      await this.manager.openFrom({ ...ev, reserves: hot.reserves }, decision.lamports);
    } catch (err) {
      metrics.inc('pipeline.error');
      log.error('pipeline error', { ...tag, err });
    } finally {
      this.inFlight--;
    }
  }

  private async refreshBalance(): Promise<void> {
    if (this.cfg.MODE !== 'live') {
      this.risk.setWalletBalance(
        this.executor instanceof PaperExecutor ? this.executor.balance : 5_000_000_000n,
      );
      return;
    }
    try {
      const lamports = await this.pool.call('getBalance', (c) => c.getBalance(this.owner, 'confirmed'));
      this.risk.setWalletBalance(BigInt(lamports));
    } catch (err) {
      log.warn('balance refresh failed', { err });
    }
  }

  /** Probes the live account layout before any transaction is built. */
  async calibrate(sampleMint: string): Promise<void> {
    const report = await probePumpLayout(this.pool, new PublicKey(sampleMint));
    this.layout = report.layout;
    log.info('calibrated', { ...report });
  }

  async stop(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    log.warn('shutting down', { reason });
    this.dashboard.stop();
    this.dashboard.render();
    await Promise.allSettled([this.pumpDetector?.stop(), this.rayDetector?.stop()]);
    if (this.balanceTimer) clearInterval(this.balanceTimer);
    this.blockhash.stop();
    this.fees.stop();
    // Positions are deliberately NOT liquidated on a normal shutdown: the book
    // is durable and management resumes on the next start. Dumping a bag
    // because the operator pressed Ctrl+C is its own kind of loss.
    this.reputation.flush();
    this.store.prune();
    log.info('final metrics', metrics.snapshot().counters);
  }

  get riskEngine(): RiskEngine {
    return this.risk;
  }

  get positions(): PositionStore {
    return this.store;
  }
}
