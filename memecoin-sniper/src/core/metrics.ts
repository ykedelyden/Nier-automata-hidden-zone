import { Ring, percentile } from './util.js';

/**
 * In-process counters and latency histograms. Everything the dashboard and the
 * post-run report read comes from here.
 */
class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly timers = new Map<string, Ring<number>>();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  observe(name: string, ms: number): void {
    let ring = this.timers.get(name);
    if (!ring) {
      ring = new Ring<number>(512);
      this.timers.set(name, ring);
    }
    ring.push(ms);
  }

  /** Times `fn` under `name` whether it resolves or rejects. */
  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.observe(name, performance.now() - t0);
    }
  }

  snapshot(): { counters: Record<string, number>; latency: Record<string, LatencyStat> } {
    const latency: Record<string, LatencyStat> = {};
    for (const [name, ring] of this.timers) {
      const v = ring.values();
      if (v.length === 0) continue;
      latency[name] = {
        n: v.length,
        p50: percentile(v, 50),
        p90: percentile(v, 90),
        p99: percentile(v, 99),
        max: Math.max(...v),
      };
    }
    return { counters: Object.fromEntries(this.counters), latency };
  }
}

export interface LatencyStat {
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

export const metrics = new Metrics();
