import { PublicKey } from '@solana/web3.js';
import { bondingCurvePda } from '../chain/programs.js';
import type { RpcPool } from '../chain/rpcPool.js';
import type { Config } from '../config.js';
import { makeLogger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import { shortId, sol } from '../core/util.js';
import type { EntryResult, Executor, LaunchEvent, Position, Reserves, SendOutcome } from '../types.js';
import { applyBuy, grossUpBuy, solForTokens, spotPrice, tokensForSol } from './pumpfun/curve.js';
import { decodeBondingCurve } from './pumpfun/layout.js';

const log = makeLogger('exec:paper');

/**
 * Paper executor: real chain state, imaginary money.
 *
 * Reserves, prices and curve progression are read live, so a paper run is
 * exposed to exactly the same launches and the same price action as a live one.
 * Only the transaction is withheld.
 *
 * Two frictions are modelled explicitly because leaving them out is what makes
 * most paper results worthless:
 *
 * - **Fill delay.** A real entry lands one to three slots after detection, by
 *   which time other snipers have moved the curve. The fill is therefore priced
 *   against reserves advanced by a simulated competing flow.
 * - **Fee drag.** Priority fee, protocol fee and (when enabled) the Jito tip
 *   are all deducted, since on a 0.02 SOL clip they are a material share of PnL.
 */
export class PaperExecutor implements Executor {
  readonly venue = 'pumpfun' as const;
  private virtualSol: bigint;

  constructor(
    private readonly pool: RpcPool,
    private readonly cfg: Config,
    startingLamports = 5_000_000_000n,
  ) {
    this.virtualSol = startingLamports;
  }

  get balance(): bigint {
    return this.virtualSol;
  }

  async buy(ev: LaunchEvent, lamports: bigint, _owner: PublicKey): Promise<EntryResult> {
    const mint = new PublicKey(ev.mint);
    const observed = ev.reserves ?? (await this.readReserves(mint));
    if (observed.complete) throw new Error('curve already complete');

    // Competing snipers land ahead of us. Assume between 0.3 and 2.5 SOL of
    // flow arrives first — the realistic band for a launch worth sniping.
    const frontrun = BigInt(Math.floor((0.3 + Math.random() * 2.2) * 1e9));
    const frontrunTokens = tokensForSol(observed, frontrun);
    const filled = applyBuy(observed, frontrun, frontrunTokens);

    const intoCurve = (lamports * 10_000n) / 10_100n;
    const tokensRaw = tokensForSol(filled, intoCurve);
    if (tokensRaw <= 0n) throw new Error('simulated fill returned zero tokens');

    const priorityFee = (BigInt(this.cfg.PRIORITY_FEE_MICROLAMPORTS) * BigInt(this.cfg.CU_LIMIT_BUY)) / 1_000_000n;
    const tip = this.cfg.JITO_ENABLED ? BigInt(this.cfg.JITO_TIP_LAMPORTS) : 0n;
    const total = grossUpBuy(intoCurve) + priorityFee + tip + 5_000n;

    if (total > this.virtualSol) throw new Error('paper wallet out of funds');
    this.virtualSol -= total;

    const decimals = 6;
    const entryPrice = (Number(total) / Number(tokensRaw)) * 10 ** decimals;
    metrics.inc('exec.paper.buy');
    log.info('paper entry', {
      mint: ev.mint,
      spent: sol(total),
      frontrunAssumed: sol(frontrun),
      tokens: tokensRaw,
    });

    return {
      send: { signature: `paper-${shortId()}`, route: 'paper', landedMs: 400 + Math.random() * 900, slot: ev.slot },
      tokensRaw,
      costLamports: total,
      tokenDecimals: decimals,
      entryPrice,
    };
  }

  async sell(pos: Position, tokensRaw: bigint, _owner: PublicKey, urgency: number): Promise<SendOutcome> {
    const reserves = await this.readReserves(new PublicKey(pos.mint));
    let proceeds = solForTokens(reserves, tokensRaw);

    // An urgent exit is an exit into a falling book; charge for it.
    const urgencyPenaltyBps = BigInt(Math.min(2_000, urgency * 400));
    proceeds -= (proceeds * urgencyPenaltyBps) / 10_000n;

    const priorityFee = (BigInt(this.cfg.PRIORITY_FEE_MICROLAMPORTS) * BigInt(this.cfg.CU_LIMIT_SELL)) / 1_000_000n;
    const net = proceeds - priorityFee - 5_000n;
    this.virtualSol += net > 0n ? net : 0n;

    metrics.inc('exec.paper.sell');
    log.info('paper exit', { mint: pos.mint, tokens: tokensRaw, received: sol(net), urgency });
    return {
      signature: `paper-${shortId()}`,
      route: 'paper',
      landedMs: 500 + Math.random() * 1_500,
      slot: null,
    };
  }

  async price(pos: Position): Promise<number> {
    const reserves = await this.readReserves(new PublicKey(pos.mint));
    return spotPrice(reserves, pos.tokenDecimals);
  }

  async balanceOf(_owner: PublicKey, _mint: PublicKey): Promise<bigint> {
    // Paper positions track their own size; nothing on chain to read.
    return 0n;
  }

  private async readReserves(mint: PublicKey): Promise<Reserves> {
    const info = await this.pool.race(
      'getAccountInfo',
      (c) => c.getAccountInfo(bondingCurvePda(mint), { commitment: 'processed' }),
      2_500,
    );
    if (!info) throw new Error(`bonding curve for ${mint.toBase58()} not found`);
    const s = decodeBondingCurve(info.data);
    return {
      virtualSol: s.virtualSol,
      virtualToken: s.virtualToken,
      realSol: s.realSol,
      realToken: s.realToken,
      tokenTotalSupply: s.tokenTotalSupply,
      complete: s.complete,
    };
  }
}
