import { ComputeBudgetProgram, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { makeLogger } from '../core/logger.js';
import { clamp, percentile } from '../core/util.js';
import type { RpcPool } from './rpcPool.js';

const log = makeLogger('fees');

/**
 * Tracks the going rate for priority fees and translates an "urgency" into a
 * concrete compute-unit price.
 *
 * Urgency 0 is a normal entry. Each exit retry raises urgency, which matters:
 * when a token is dumping, the fee needed to land a sell rises fast, and a
 * static fee means the exit never lands.
 */
export class FeeOracle {
  private observed: number[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: RpcPool,
    private readonly baseMicroLamports: number,
    private readonly maxMicroLamports: number,
    private readonly sampleMs = 5_000,
  ) {}

  async start(hotAccounts: PublicKey[] = []): Promise<void> {
    const sample = async () => {
      try {
        const fees = await this.pool.call(
          'getRecentPrioritizationFees',
          (c) => c.getRecentPrioritizationFees({ lockedWritableAccounts: hotAccounts }),
          3_000,
        );
        const values = fees.map((f) => f.prioritizationFee).filter((v) => v > 0);
        if (values.length > 0) this.observed = values;
      } catch (err) {
        log.debug('fee sample failed', { err });
      }
    };
    await sample();
    this.timer = setInterval(() => void sample(), this.sampleMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Network p75 is the floor for an entry; anything less loses the block on a
   * hot launch. Urgency multiplies geometrically and is hard-capped so a
   * runaway retry loop cannot drain the wallet in fees.
   */
  microLamports(urgency = 0): number {
    const network = this.observed.length > 0 ? percentile(this.observed, 75) : 0;
    const floor = Math.max(this.baseMicroLamports, Math.ceil(network * 1.25));
    const escalated = floor * 1.8 ** clamp(urgency, 0, 6);
    return Math.ceil(clamp(escalated, 1_000, this.maxMicroLamports));
  }

  /** The two compute-budget instructions that must lead every transaction. */
  budgetIxs(computeUnits: number, urgency = 0): TransactionInstruction[] {
    return [
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.microLamports(urgency) }),
    ];
  }

  /** Priority fee in lamports for a given CU limit — used for PnL accounting. */
  estimateLamports(computeUnits: number, urgency = 0): bigint {
    return (BigInt(this.microLamports(urgency)) * BigInt(computeUnits)) / 1_000_000n;
  }

  stats(): { samples: number; p50: number; p75: number; p95: number } {
    return {
      samples: this.observed.length,
      p50: percentile(this.observed, 50),
      p75: percentile(this.observed, 75),
      p95: percentile(this.observed, 95),
    };
  }
}
