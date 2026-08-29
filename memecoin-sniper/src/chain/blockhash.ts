import type { BlockhashWithExpiryBlockHeight } from '@solana/web3.js';
import { makeLogger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import type { RpcPool } from './rpcPool.js';

const log = makeLogger('blockhash');

/**
 * Keeps a recent blockhash hot in memory.
 *
 * Fetching a blockhash inside the snipe path costs 40-150ms, which is most of
 * the budget. Refreshing it on a timer means the entry transaction is built
 * from memory. A blockhash stays valid ~60s, so a 1.2s refresh is very safe
 * while keeping the cached value near-maximally fresh.
 */
export class BlockhashCache {
  private current: BlockhashWithExpiryBlockHeight | null = null;
  private fetchedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly pool: RpcPool,
    private readonly refreshMs = 1_200,
  ) {}

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = metrics
      .time('blockhash.refresh', () =>
        this.pool.race('getLatestBlockhash', (c) => c.getLatestBlockhash('confirmed'), 2_500),
      )
      .then((bh) => {
        this.current = bh;
        this.fetchedAt = Date.now();
      })
      .catch((err) => {
        log.warn('refresh failed', { err });
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Age of the cached blockhash in ms; `Infinity` when nothing is cached. */
  get ageMs(): number {
    return this.current ? Date.now() - this.fetchedAt : Number.POSITIVE_INFINITY;
  }

  /**
   * Returns the cached blockhash. Throws instead of blocking if the cache is
   * cold or stale — a snipe built on a dead blockhash is worse than a skip.
   */
  get(maxAgeMs = 30_000): BlockhashWithExpiryBlockHeight {
    if (!this.current) throw new Error('blockhash cache is cold');
    if (this.ageMs > maxAgeMs) {
      void this.refresh();
      throw new Error(`blockhash stale by ${Math.round(this.ageMs)}ms`);
    }
    return this.current;
  }

  /** For the exit path, where correctness beats latency. */
  async getFresh(): Promise<BlockhashWithExpiryBlockHeight> {
    if (this.ageMs > 5_000) await this.refresh();
    if (!this.current) throw new Error('blockhash unavailable');
    return this.current;
  }
}
