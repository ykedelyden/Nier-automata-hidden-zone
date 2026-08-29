import { makeLogger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import type { LaunchEvent } from '../types.js';

const log = makeLogger('dispatch');

interface SeenEntry {
  readonly at: number;
  readonly detector: string;
}

/**
 * Deduplicates launches arriving from several detectors and several RPC nodes.
 *
 * Every subscription reports the same create, so the first arrival wins and the
 * rest are counted as "duplicates". The spread between the first and last
 * arrival is exported as `dispatch.spread` — it is the single best measure of
 * how much edge the current RPC mix is buying.
 */
export class Dispatcher {
  private seq = 0;
  private readonly seen = new Map<string, SeenEntry>();
  private readonly firstArrival = new Map<string, number>();

  constructor(
    private readonly onLaunch: (ev: LaunchEvent) => void,
    private readonly ttlMs = 10 * 60_000,
  ) {
    const timer = setInterval(() => this.evict(), 60_000);
    timer.unref?.();
  }

  submit(raw: Omit<LaunchEvent, 'seq'>): void {
    const prior = this.seen.get(raw.mint);
    if (prior) {
      metrics.inc('dispatch.duplicate');
      const first = this.firstArrival.get(raw.mint);
      if (first !== undefined) metrics.observe('dispatch.spread', raw.seenAt - first);
      log.trace('duplicate launch', {
        mint: raw.mint,
        winner: prior.detector,
        loser: raw.detector,
      });
      return;
    }
    this.seen.set(raw.mint, { at: Date.now(), detector: raw.detector });
    this.firstArrival.set(raw.mint, raw.seenAt);
    metrics.inc('dispatch.unique');
    metrics.inc(`dispatch.win.${raw.detector.split('@')[0]}`);
    this.onLaunch({ ...raw, seq: ++this.seq });
  }

  private evict(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [mint, entry] of this.seen) {
      if (entry.at < cutoff) {
        this.seen.delete(mint);
        this.firstArrival.delete(mint);
      }
    }
  }

  get tracked(): number {
    return this.seen.size;
  }
}
