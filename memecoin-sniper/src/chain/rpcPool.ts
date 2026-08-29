import { Connection } from '@solana/web3.js';
import { makeLogger } from '../core/logger.js';
import { Ring, percentile, withTimeout } from '../core/util.js';

const log = makeLogger('rpc');

interface Node {
  readonly label: string;
  readonly url: string;
  readonly conn: Connection;
  readonly latency: Ring<number>;
  errors: number;
  successes: number;
  /** Set while a node is being rested after repeated failures. */
  penaltyUntil: number;
}

function labelFor(url: string, i: number): string {
  try {
    return `${new URL(url).hostname.split('.').slice(-3, -2)[0] ?? 'rpc'}#${i}`;
  } catch {
    return `rpc#${i}`;
  }
}

/**
 * A pool of interchangeable RPC endpoints with health scoring.
 *
 * Reads go to the healthiest node; latency-critical reads can be raced across
 * every node with `race()`. Nodes that error repeatedly are rested rather than
 * evicted, because a rate-limited endpoint usually recovers within seconds.
 */
export class RpcPool {
  private readonly nodes: Node[];
  private rr = 0;

  constructor(urls: readonly string[], wsUrls: readonly string[] = []) {
    if (urls.length === 0) throw new Error('RpcPool needs at least one endpoint');
    this.nodes = urls.map((url, i) => ({
      label: labelFor(url, i),
      url,
      conn: new Connection(url, {
        commitment: 'processed',
        disableRetryOnRateLimit: true,
        confirmTransactionInitialTimeout: 30_000,
        ...(wsUrls[i] ? { wsEndpoint: wsUrls[i] } : {}),
      }),
      latency: new Ring<number>(64),
      errors: 0,
      successes: 0,
      penaltyUntil: 0,
    }));
    log.info('pool ready', { nodes: this.nodes.length });
  }

  get size(): number {
    return this.nodes.length;
  }

  /** All connections, for detectors that need to open their own subscriptions. */
  connections(): ReadonlyArray<{ label: string; conn: Connection }> {
    return this.nodes.map((n) => ({ label: n.label, conn: n.conn }));
  }

  /** Lower is better: p50 latency inflated by the node's recent error rate. */
  private score(n: Node): number {
    if (Date.now() < n.penaltyUntil) return Number.POSITIVE_INFINITY;
    const p50 = n.latency.size > 0 ? percentile(n.latency.values(), 50) : 400;
    const attempts = n.errors + n.successes;
    const errRate = attempts > 0 ? n.errors / attempts : 0;
    return p50 * (1 + 4 * errRate);
  }

  private best(): Node {
    let best = this.nodes[0]!;
    let bestScore = this.score(best);
    for (const n of this.nodes.slice(1)) {
      const s = this.score(n);
      if (s < bestScore) {
        best = n;
        bestScore = s;
      }
    }
    if (!Number.isFinite(bestScore)) {
      // Everything is penalised; fall back to round-robin so we still make progress.
      best = this.nodes[this.rr++ % this.nodes.length]!;
    }
    return best;
  }

  /** The single healthiest connection, for non-critical reads. */
  primary(): Connection {
    return this.best().conn;
  }

  private record(n: Node, ms: number, ok: boolean): void {
    if (ok) {
      n.successes++;
      n.latency.push(ms);
      return;
    }
    n.errors++;
    if (n.errors >= 5 && n.errors > n.successes) {
      n.penaltyUntil = Date.now() + 15_000;
      n.errors = 0;
      n.successes = 0;
      log.warn('node rested', { node: n.label, forMs: 15_000 });
    }
  }

  /** Runs `fn` on the healthiest node, failing over to the others in order. */
  async call<T>(label: string, fn: (c: Connection) => Promise<T>, timeoutMs = 4_000): Promise<T> {
    const ordered = [...this.nodes].sort((a, b) => this.score(a) - this.score(b));
    const errors: Error[] = [];
    for (const node of ordered) {
      const t0 = performance.now();
      try {
        const out = await withTimeout(fn(node.conn), timeoutMs, `${label}@${node.label}`);
        this.record(node, performance.now() - t0, true);
        return out;
      } catch (err) {
        this.record(node, performance.now() - t0, false);
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    throw new AggregateError(errors, `${label}: every RPC failed`);
  }

  /**
   * Fires `fn` at every node at once and returns the first success. Costs N
   * requests; reserve it for the pre-trade path where milliseconds decide.
   */
  async race<T>(label: string, fn: (c: Connection) => Promise<T>, timeoutMs = 2_000): Promise<T> {
    const live = this.nodes.filter((n) => Date.now() >= n.penaltyUntil);
    const pool = live.length > 0 ? live : this.nodes;
    return new Promise<T>((resolve, reject) => {
      let pending = pool.length;
      const errors: Error[] = [];
      for (const node of pool) {
        const t0 = performance.now();
        withTimeout(fn(node.conn), timeoutMs, `${label}@${node.label}`).then(
          (value) => {
            this.record(node, performance.now() - t0, true);
            resolve(value);
          },
          (err) => {
            this.record(node, performance.now() - t0, false);
            errors.push(err instanceof Error ? err : new Error(String(err)));
            if (--pending === 0) reject(new AggregateError(errors, `${label}: every RPC failed`));
          },
        );
      }
    });
  }

  health(): Array<{ node: string; p50: number; errors: number; rested: boolean }> {
    return this.nodes.map((n) => ({
      node: n.label,
      p50: n.latency.size > 0 ? percentile(n.latency.values(), 50) : -1,
      errors: n.errors,
      rested: Date.now() < n.penaltyUntil,
    }));
  }
}
