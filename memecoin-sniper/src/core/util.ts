export const LAMPORTS_PER_SOL = 1_000_000_000n;

export function sol(lamports: bigint | number): string {
  const n = typeof lamports === 'bigint' ? lamports : BigInt(Math.round(lamports));
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, '0').slice(0, 4);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Rejects with `TimeoutError` if `p` has not settled within `ms`. */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
}

/**
 * Resolves with the first promise to fulfil. Unlike `Promise.any` it reports
 * which entry won, which is what the send path needs for route attribution.
 */
export function firstToLand<T>(
  entries: Array<{ label: string; run: () => Promise<T> }>,
): Promise<{ label: string; value: T }> {
  if (entries.length === 0) return Promise.reject(new Error('firstToLand: no entries'));
  return new Promise((resolve, reject) => {
    let pending = entries.length;
    const errors: Error[] = [];
    for (const { label, run } of entries) {
      run().then(
        (value) => resolve({ label, value }),
        (err) => {
          errors.push(err instanceof Error ? err : new Error(String(err)));
          if (--pending === 0) {
            reject(new AggregateError(errors, 'all routes failed'));
          }
        },
      );
    }
  });
}

/** Exponential backoff with full jitter, capped. */
export function backoffMs(attempt: number, base = 250, cap = 8_000): number {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Fixed-capacity ring buffer, used for latency and price histories. */
export class Ring<T> {
  private readonly buf: T[] = [];
  constructor(private readonly cap: number) {}
  push(v: T): void {
    this.buf.push(v);
    if (this.buf.length > this.cap) this.buf.shift();
  }
  values(): readonly T[] {
    return this.buf;
  }
  get size(): number {
    return this.buf.length;
  }
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp(Math.ceil((p / 100) * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[idx]!;
}

/** Deterministic short id, good enough to label positions in logs. */
export function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function truncMint(mint: string): string {
  return mint.length <= 12 ? mint : `${mint.slice(0, 5)}..${mint.slice(-4)}`;
}
