import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../core/logger.js';
import type { Position } from '../types.js';

const log = makeLogger('positions');

interface Serialised extends Omit<Position, 'costLamports' | 'tokensRaw' | 'realisedLamports'> {
  costLamports: string;
  tokensRaw: string;
  realisedLamports: string;
}

function toWire(p: Position): Serialised {
  return {
    ...p,
    costLamports: p.costLamports.toString(),
    tokensRaw: p.tokensRaw.toString(),
    realisedLamports: p.realisedLamports.toString(),
  };
}

function fromWire(s: Serialised): Position {
  return {
    ...s,
    costLamports: BigInt(s.costLamports),
    tokensRaw: BigInt(s.tokensRaw),
    realisedLamports: BigInt(s.realisedLamports),
  };
}

/**
 * Crash-durable position book.
 *
 * A sniper that dies holding a bag and forgets about it is strictly worse than
 * one that never opened the trade, so open positions are written through on
 * every mutation and reloaded on boot. Writes go to a temp file and are renamed
 * into place, so a kill during a write cannot truncate the book.
 */
export class PositionStore {
  private readonly path: string;
  private readonly positions = new Map<string, Position>();

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.path = join(stateDir, 'positions.json');
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Serialised[];
      for (const s of raw) {
        const p = fromWire(s);
        this.positions.set(p.id, p);
      }
      const open = this.open().length;
      if (open > 0) log.warn('recovered open positions from a previous run', { open });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') log.warn('could not load position book', { err });
    }
  }

  private persist(): void {
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.positions.values()].map(toWire), null, 2));
      renameSync(tmp, this.path);
    } catch (err) {
      log.error('failed to persist position book', { err });
    }
  }

  put(p: Position): void {
    this.positions.set(p.id, p);
    this.persist();
  }

  get(id: string): Position | null {
    return this.positions.get(id) ?? null;
  }

  byMint(mint: string): Position | null {
    for (const p of this.positions.values()) {
      if (p.mint === mint && p.state !== 'closed' && p.state !== 'failed-entry') return p;
    }
    return null;
  }

  open(): Position[] {
    return [...this.positions.values()].filter(
      (p) => p.state === 'open' || p.state === 'exiting' || p.state === 'pending-entry',
    );
  }

  all(): Position[] {
    return [...this.positions.values()];
  }

  /** Drops closed positions older than `maxAgeMs` so the file stays small. */
  prune(maxAgeMs = 7 * 86_400_000): void {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [id, p] of this.positions) {
      if (p.state === 'closed' && (p.closedAt ?? 0) < cutoff) {
        this.positions.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.persist();
  }
}
