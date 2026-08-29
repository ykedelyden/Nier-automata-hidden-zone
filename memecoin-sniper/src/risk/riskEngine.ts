import type { Config } from '../config.js';
import { makeLogger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import { sol } from '../core/util.js';
import { convictionMultiplier } from '../analysis/scorer.js';

const log = makeLogger('risk');

export type RiskDecision =
  | { readonly allowed: true; readonly lamports: bigint; readonly note: string }
  | { readonly allowed: false; readonly reason: string };

interface DayBook {
  /** UTC day key, so the book rolls at a fixed boundary. */
  day: string;
  realised: bigint;
  trades: number;
  wins: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The component that decides how much — if anything — is at stake.
 *
 * It is intentionally the last word before any buy. Every other module can be
 * optimistic; this one exists to be pessimistic, and it holds three independent
 * brakes: an exposure cap, a daily loss limit, and a consecutive-loss cooldown.
 * Any one of them can stop trading on its own.
 */
export class RiskEngine {
  private book: DayBook = { day: today(), realised: 0n, trades: 0, wins: 0 };
  private consecutiveLosses = 0;
  private cooldownUntil = 0;
  private openExposure = 0n;
  private halted: string | null = null;
  private walletLamports = 0n;

  constructor(private readonly cfg: Config) {}

  /** Refreshed by the runtime from the wallet balance. */
  setWalletBalance(lamports: bigint): void {
    this.walletLamports = lamports;
  }

  private rollDay(): void {
    const d = today();
    if (this.book.day !== d) {
      log.info('daily book rolled', {
        previous: this.book.day,
        realised: sol(this.book.realised),
        trades: this.book.trades,
      });
      this.book = { day: d, realised: 0n, trades: 0, wins: 0 };
      // A new day clears the loss-limit halt but never a manual halt.
      if (this.halted === 'daily-loss-limit') this.halted = null;
    }
  }

  /**
   * @param scoreValue conviction from the scorer, used for sizing
   * @param openPositions how many trades are currently live
   */
  approve(scoreValue: number, openPositions: number): RiskDecision {
    this.rollDay();

    if (this.halted) return { allowed: false, reason: `halted: ${this.halted}` };

    if (Date.now() < this.cooldownUntil) {
      const left = Math.ceil((this.cooldownUntil - Date.now()) / 1000);
      return { allowed: false, reason: `cooling down for ${left}s after ${this.consecutiveLosses} losses` };
    }

    if (openPositions >= this.cfg.MAX_CONCURRENT_POSITIONS) {
      return { allowed: false, reason: `at position cap (${openPositions})` };
    }

    const multiplier = convictionMultiplier(scoreValue, this.cfg.MIN_SCORE);
    if (multiplier <= 0) return { allowed: false, reason: 'conviction below threshold' };

    let lamports = BigInt(Math.floor(this.cfg.BUY_LAMPORTS * multiplier));

    const exposureHeadroom = BigInt(this.cfg.MAX_EXPOSURE_LAMPORTS) - this.openExposure;
    if (exposureHeadroom <= 0n) {
      return { allowed: false, reason: `exposure cap reached (${sol(this.openExposure)} SOL open)` };
    }
    if (lamports > exposureHeadroom) lamports = exposureHeadroom;

    if (this.walletLamports > 0n) {
      const spendable = this.walletLamports - BigInt(this.cfg.MIN_WALLET_RESERVE_LAMPORTS);
      if (spendable <= 0n) {
        return { allowed: false, reason: `wallet below reserve (${sol(this.walletLamports)} SOL)` };
      }
      if (lamports > spendable) lamports = spendable;
    }

    // A clip too small is pure fee burn; refuse rather than trade it badly.
    const floor = BigInt(Math.floor(this.cfg.BUY_LAMPORTS * 0.25));
    if (lamports < floor) {
      return { allowed: false, reason: `sized down to ${sol(lamports)} SOL, below the useful floor` };
    }

    return {
      allowed: true,
      lamports,
      note: `${multiplier.toFixed(2)}x of base on score ${scoreValue.toFixed(3)}`,
    };
  }

  /** Called the moment an entry is committed, before it confirms. */
  reserve(lamports: bigint): void {
    this.openExposure += lamports;
  }

  /** Called if an entry fails, to release the reservation. */
  release(lamports: bigint): void {
    this.openExposure -= lamports;
    if (this.openExposure < 0n) this.openExposure = 0n;
  }

  /** Called once a position is fully closed. `pnl` is net of all fees. */
  settle(cost: bigint, pnl: bigint): void {
    this.rollDay();
    this.release(cost);
    this.book.realised += pnl;
    this.book.trades++;

    if (pnl > 0n) {
      this.book.wins++;
      this.consecutiveLosses = 0;
    } else {
      this.consecutiveLosses++;
      metrics.inc('risk.loss');
      if (this.consecutiveLosses >= this.cfg.CONSECUTIVE_LOSS_COOLDOWN) {
        this.cooldownUntil = Date.now() + this.cfg.COOLDOWN_MS;
        log.warn('cooldown engaged', {
          losses: this.consecutiveLosses,
          forMs: this.cfg.COOLDOWN_MS,
        });
        // The streak resets on engaging so the cooldown is not re-armed on
        // every subsequent loss inside the same bad run.
        this.consecutiveLosses = 0;
      }
    }

    if (this.book.realised <= -BigInt(this.cfg.DAILY_LOSS_LIMIT_LAMPORTS)) {
      this.halt('daily-loss-limit');
    }
  }

  halt(reason: string): void {
    if (this.halted) return;
    this.halted = reason;
    log.error('TRADING HALTED', { reason, realisedToday: sol(this.book.realised) });
  }

  resume(): void {
    this.halted = null;
    this.cooldownUntil = 0;
    this.consecutiveLosses = 0;
  }

  get isHalted(): boolean {
    return this.halted !== null;
  }

  status(): {
    day: string;
    realised: string;
    trades: number;
    wins: number;
    openExposure: string;
    halted: string | null;
    cooldownMsLeft: number;
  } {
    return {
      day: this.book.day,
      realised: sol(this.book.realised),
      trades: this.book.trades,
      wins: this.book.wins,
      openExposure: sol(this.openExposure),
      halted: this.halted,
      cooldownMsLeft: Math.max(0, this.cooldownUntil - Date.now()),
    };
  }
}
