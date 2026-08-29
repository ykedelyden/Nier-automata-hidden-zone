import type { PublicKey } from '@solana/web3.js';
import type { ColdAuditor, RugSignal } from '../analysis/coldAudit.js';
import type { ReputationStore } from '../analysis/reputation.js';
import type { Config } from '../config.js';
import { bus } from '../core/bus.js';
import { makeLogger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import { shortId, sleep, sol, truncMint } from '../core/util.js';
import type { RiskEngine } from '../risk/riskEngine.js';
import type { Executor, LaunchEvent, Position } from '../types.js';
import type { PositionStore } from './store.js';

const log = makeLogger('position');

export interface ExitPlan {
  /** Fraction of the *remaining* bag to sell, 0..1. */
  readonly fraction: number;
  readonly reason: string;
  /** Higher means pay more to land the sell. */
  readonly urgency: number;
  /** Set when the exit came from a take-profit rung, so it is not retaken. */
  readonly rungIndex?: number;
  /** Set when this is the one-off partial de-risking exit. */
  readonly derisk?: boolean;
}

/**
 * Owns every open position from fill to close.
 *
 * The exit logic is where a sniper actually makes or loses money, so it runs
 * several independent rules in priority order and takes the most aggressive one
 * that fires. In order of precedence:
 *
 * 1. **Rug signals** from the cold auditor — full exit, maximum urgency.
 * 2. **Hard stop** — the position is down past the pain threshold.
 * 3. **Trailing stop** — arms only after the trade is meaningfully up, so a
 *    normal first-minute wick cannot stop out a good entry.
 * 4. **Take-profit ladder** — scales out on the way up so a reversal never
 *    turns a winner into a loser.
 * 5. **Stagnation / max hold** — capital that is doing nothing is capital not
 *    available for the next launch, which is the real cost in this game.
 */
export class PositionManager {
  private readonly loops = new Map<string, AbortController>();

  constructor(
    private readonly cfg: Config,
    private readonly store: PositionStore,
    private readonly executor: Executor,
    private readonly auditor: ColdAuditor,
    private readonly risk: RiskEngine,
    private readonly reputation: ReputationStore,
    private readonly owner: PublicKey,
  ) {}

  /** Re-arms management loops for positions recovered from disk. */
  resumeAll(): void {
    for (const p of this.store.open()) {
      if (p.state === 'pending-entry') {
        // An entry that was in flight when the process died cannot be
        // reconstructed safely; mark it and let the operator reconcile.
        p.state = 'failed-entry';
        p.exitReason = 'process restarted mid-entry';
        this.store.put(p);
        this.risk.release(p.costLamports);
        log.warn('abandoned in-flight entry after restart', { mint: p.mint });
        continue;
      }
      log.warn('resuming management of recovered position', { mint: truncMint(p.mint) });
      this.spawn(p);
    }
  }

  async openFrom(ev: LaunchEvent, lamports: bigint): Promise<Position | null> {
    if (this.store.byMint(ev.mint)) {
      log.debug('already holding this mint', { mint: ev.mint });
      return null;
    }

    const pos: Position = {
      id: shortId(),
      mint: ev.mint,
      venue: ev.venue,
      creator: ev.creator,
      state: 'pending-entry',
      costLamports: lamports,
      tokensRaw: 0n,
      tokenDecimals: 6,
      entryPrice: 0,
      peakPrice: 0,
      lastPrice: 0,
      rungsHit: [],
      derisked: false,
      openedAt: Date.now(),
      closedAt: null,
      realisedLamports: 0n,
      entrySignature: null,
      exitSignatures: [],
      accounts: ev.accounts,
      exitReason: null,
      exitAttempts: 0,
    };
    this.store.put(pos);
    this.risk.reserve(lamports);

    try {
      const entry = await this.executor.buy(ev, lamports, this.owner);
      pos.state = 'open';
      pos.tokensRaw = entry.tokensRaw;
      pos.tokenDecimals = entry.tokenDecimals;
      pos.costLamports = entry.costLamports;
      pos.entryPrice = entry.entryPrice;
      pos.peakPrice = entry.entryPrice;
      pos.lastPrice = entry.entryPrice;
      pos.entrySignature = entry.send.signature;
      this.store.put(pos);
      metrics.inc('position.opened');
      bus.emit('position:open', pos);
      this.spawn(pos);
      return pos;
    } catch (err) {
      pos.state = 'failed-entry';
      pos.exitReason = err instanceof Error ? err.message : String(err);
      this.store.put(pos);
      this.risk.release(lamports);
      metrics.inc('position.entry_failed');
      log.warn('entry failed', { mint: truncMint(ev.mint), err });
      return null;
    }
  }

  private spawn(pos: Position): void {
    const ctl = new AbortController();
    this.loops.set(pos.id, ctl);
    void this.manage(pos, ctl.signal).catch((err) =>
      log.error('management loop crashed', { mint: pos.mint, err }),
    );
  }

  private async manage(pos: Position, signal: AbortSignal): Promise<void> {
    let lastAuditAt = 0;
    let rugSignals: RugSignal[] = [];

    while (!signal.aborted && pos.state === 'open') {
      await sleep(this.cfg.PRICE_POLL_MS);
      if (signal.aborted) break;

      try {
        pos.lastPrice = await this.executor.price(pos);
        if (pos.lastPrice > pos.peakPrice) pos.peakPrice = pos.lastPrice;
      } catch (err) {
        log.debug('price poll failed', { mint: truncMint(pos.mint), err });
        continue;
      }

      // The auditor is far more expensive than a price read, so it runs on a
      // slower cadence — every fourth poll or so.
      if (Date.now() - lastAuditAt > this.cfg.PRICE_POLL_MS * 4) {
        lastAuditAt = Date.now();
        rugSignals = await this.auditor.audit(pos);
      }

      const plan = this.decide(pos, rugSignals);
      bus.emit('position:update', pos);
      if (!plan) continue;

      await this.executeExit(pos, plan);
      if (pos.tokensRaw <= 0n) break;
    }

    this.loops.delete(pos.id);
  }

  /**
   * Pure decision function: no I/O and no mutation, so the whole exit policy is
   * directly unit-testable against a synthetic position.
   */
  decide(pos: Position, rugSignals: readonly RugSignal[] = []): ExitPlan | null {
    if (pos.entryPrice <= 0 || pos.tokensRaw <= 0n) return null;

    const worst = rugSignals.reduce<RugSignal | null>(
      (acc, s) => (acc === null || s.severity > acc.severity ? s : acc),
      null,
    );
    if (worst && worst.severity >= 0.8) {
      return { fraction: 1, reason: `rug:${worst.key} (${worst.detail})`, urgency: 4 };
    }

    const multiple = pos.lastPrice / pos.entryPrice;
    const heldMs = Date.now() - pos.openedAt;

    if (multiple <= 1 - this.cfg.HARD_STOP_PCT) {
      return { fraction: 1, reason: `hard stop at ${(multiple * 100 - 100).toFixed(1)}%`, urgency: 3 };
    }

    const peakMultiple = pos.peakPrice / pos.entryPrice;
    if (peakMultiple >= this.cfg.TRAILING_ARM_MULTIPLE) {
      const drawdown = 1 - pos.lastPrice / pos.peakPrice;
      if (drawdown >= this.cfg.TRAILING_STOP_PCT) {
        return {
          fraction: 1,
          reason: `trailing stop: ${(drawdown * 100).toFixed(1)}% off a ${peakMultiple.toFixed(2)}x peak`,
          urgency: 2,
        };
      }
    }

    // Ladder rungs are checked high-to-low so a violent candle through several
    // levels takes the largest applicable one rather than the smallest.
    for (let i = this.cfg.tpLadder.length - 1; i >= 0; i--) {
      const rung = this.cfg.tpLadder[i]!;
      if (pos.rungsHit.includes(i)) continue;
      if (multiple >= rung.multiple) {
        return {
          fraction: rung.fraction,
          reason: `take-profit rung ${i} at ${rung.multiple}x`,
          urgency: 1,
          rungIndex: i,
        };
      }
    }

    if (heldMs >= this.cfg.MAX_HOLD_MS) {
      return { fraction: 1, reason: `max hold ${Math.round(heldMs / 1000)}s reached`, urgency: 1 };
    }

    if (
      heldMs >= this.cfg.STAGNATION_MS &&
      Math.abs(multiple - 1) < this.cfg.STAGNATION_BAND_PCT
    ) {
      return {
        fraction: 1,
        reason: `stagnant for ${Math.round(heldMs / 1000)}s within ±${(this.cfg.STAGNATION_BAND_PCT * 100).toFixed(0)}%`,
        urgency: 0,
      };
    }

    if (worst && worst.severity >= 0.5 && !pos.derisked) {
      return {
        fraction: 0.5,
        reason: `de-risking on ${worst.key}: ${worst.detail}`,
        urgency: 2,
        derisk: true,
      };
    }

    return null;
  }

  private async executeExit(pos: Position, plan: ExitPlan): Promise<void> {
    const toSell =
      plan.fraction >= 1
        ? pos.tokensRaw
        : (pos.tokensRaw * BigInt(Math.round(plan.fraction * 10_000))) / 10_000n;
    if (toSell <= 0n) return;

    pos.state = 'exiting';
    this.store.put(pos);
    log.info('exiting', {
      mint: truncMint(pos.mint),
      fraction: plan.fraction,
      reason: plan.reason,
      multiple: pos.entryPrice > 0 ? pos.lastPrice / pos.entryPrice : 0,
    });

    try {
      const urgency = plan.urgency + pos.exitAttempts;
      const out = await this.executor.sell(pos, toSell, this.owner, urgency);
      pos.exitSignatures.push(out.signature);
      pos.tokensRaw -= toSell;
      pos.exitAttempts = 0;
      if (plan.rungIndex !== undefined) pos.rungsHit.push(plan.rungIndex);
      if (plan.derisk === true) pos.derisked = true;

      // Value the fill at the last observed price; the reconciler corrects this
      // from the wallet balance once the run ends.
      const proceeds = BigInt(
        Math.max(0, Math.floor((Number(toSell) / 10 ** pos.tokenDecimals) * pos.lastPrice)),
      );
      pos.realisedLamports += proceeds;

      if (pos.tokensRaw <= 0n) {
        this.close(pos, plan.reason);
      } else {
        pos.state = 'open';
        pos.exitReason = plan.reason;
        this.store.put(pos);
      }
    } catch (err) {
      pos.exitAttempts++;
      pos.state = 'open';
      this.store.put(pos);
      metrics.inc('position.exit_failed');
      log.warn('exit attempt failed; will escalate', {
        mint: truncMint(pos.mint),
        attempt: pos.exitAttempts,
        err,
      });
      if (pos.exitAttempts >= 6) {
        // Six failed exits means something structural — a frozen account, a
        // migrated curve. Stop burning fees and surface it.
        this.risk.halt(`cannot exit ${pos.mint} after ${pos.exitAttempts} attempts`);
      }
    }
  }

  private close(pos: Position, reason: string): void {
    pos.state = 'closed';
    pos.closedAt = Date.now();
    pos.exitReason = reason;
    this.store.put(pos);

    const pnl = pos.realisedLamports - pos.costLamports;
    const rugged = reason.startsWith('rug:') || pnl <= -(pos.costLamports * 60n) / 100n;
    this.risk.settle(pos.costLamports, pnl);
    if (pos.creator) this.reputation.noteOutcome(pos.creator, pnl, rugged);
    this.auditor.forget(pos.mint);

    metrics.inc('position.closed');
    metrics.inc(pnl > 0n ? 'position.win' : 'position.loss');
    log.info('closed', {
      mint: truncMint(pos.mint),
      pnl: sol(pnl),
      heldMs: (pos.closedAt ?? 0) - pos.openedAt,
      reason,
    });
    bus.emit('position:close', pos);
  }

  /** Force-closes everything, used on shutdown and on a risk halt. */
  async liquidateAll(reason: string): Promise<void> {
    const open = this.store.open().filter((p) => p.state === 'open' && p.tokensRaw > 0n);
    if (open.length === 0) return;
    log.warn('liquidating all positions', { count: open.length, reason });
    for (const ctl of this.loops.values()) ctl.abort();
    await Promise.allSettled(
      open.map((p) => this.executeExit(p, { fraction: 1, reason, urgency: 4 })),
    );
  }

  get openCount(): number {
    return this.store.open().length;
  }
}
