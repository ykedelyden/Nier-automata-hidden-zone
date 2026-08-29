import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeLogger } from '../core/logger.js';

const log = makeLogger('reputation');

export interface CreatorRecord {
  wallet: string;
  launches: number;
  /** Positions closed at a loss worse than -60%: the practical rug signature. */
  rugs: number;
  wins: number;
  netLamports: string;
  firstSeen: number;
  lastSeen: number;
}

/**
 * Persistent memory of the wallets behind past launches.
 *
 * Serial ruggers reuse funding wallets far more often than they should, so this
 * ends up being one of the highest-signal, lowest-cost filters available: it
 * needs no RPC call at decision time.
 */
export class ReputationStore {
  private readonly path: string;
  private records = new Map<string, CreatorRecord>();
  private dirty = false;

  constructor(stateDir: string) {
    this.path = join(stateDir, 'reputation.json');
    this.load();
    const timer = setInterval(() => this.flush(), 15_000);
    timer.unref?.();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as CreatorRecord[];
      for (const r of raw) this.records.set(r.wallet, r);
      log.info('loaded', { creators: this.records.size });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') log.warn('load failed, starting empty', { err });
    }
  }

  flush(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify([...this.records.values()], null, 2));
      this.dirty = false;
    } catch (err) {
      log.warn('flush failed', { err });
    }
  }

  get(wallet: string): CreatorRecord | null {
    return this.records.get(wallet) ?? null;
  }

  noteLaunch(wallet: string): CreatorRecord {
    const now = Date.now();
    const existing = this.records.get(wallet);
    if (existing) {
      existing.launches++;
      existing.lastSeen = now;
      this.dirty = true;
      return existing;
    }
    const fresh: CreatorRecord = {
      wallet,
      launches: 1,
      rugs: 0,
      wins: 0,
      netLamports: '0',
      firstSeen: now,
      lastSeen: now,
    };
    this.records.set(wallet, fresh);
    this.dirty = true;
    return fresh;
  }

  noteOutcome(wallet: string, pnlLamports: bigint, rugged: boolean): void {
    const rec = this.records.get(wallet) ?? this.noteLaunch(wallet);
    if (rugged) rec.rugs++;
    else if (pnlLamports > 0n) rec.wins++;
    rec.netLamports = (BigInt(rec.netLamports) + pnlLamports).toString();
    rec.lastSeen = Date.now();
    this.dirty = true;
  }

  /**
   * A wallet is blacklisted once it has rugged twice, or once on its only
   * launch — one rug is already enough evidence when there is nothing else.
   */
  isBlacklisted(wallet: string): boolean {
    const rec = this.records.get(wallet);
    if (!rec) return false;
    return rec.rugs >= 2 || (rec.rugs === 1 && rec.launches <= 2);
  }

  /** -1 (known rugger) .. +1 (consistently profitable creator). */
  score(wallet: string): number {
    const rec = this.records.get(wallet);
    if (!rec) return 0;
    const total = rec.rugs + rec.wins;
    if (total === 0) return rec.launches > 4 ? -0.15 : 0; // serial launcher, no wins yet
    return (rec.wins - 2 * rec.rugs) / (total + 2);
  }

  size(): number {
    return this.records.size;
  }
}
