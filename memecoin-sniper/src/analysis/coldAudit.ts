import { PublicKey } from '@solana/web3.js';
import { PROGRAMS, ata, bondingCurvePda } from '../chain/programs.js';
import type { RpcPool } from '../chain/rpcPool.js';
import { makeLogger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import { decodeBondingCurve, decodeTokenAmount } from '../exec/pumpfun/layout.js';
import type { Position } from '../types.js';

const log = makeLogger('audit:cold');

export interface RugSignal {
  readonly key: string;
  readonly detail: string;
  /** 0..1. The position manager exits immediately at >= 0.8. */
  readonly severity: number;
}

/**
 * Post-entry surveillance.
 *
 * Checks that are too slow for the pre-trade budget still matter enormously
 * once capital is committed — a developer dumping their allocation is usually
 * visible ten to thirty seconds before the price collapses. This runs on a
 * slower cadence than the price poll and feeds the exit logic.
 */
export class ColdAuditor {
  /** Highest dev balance observed, to detect a *decrease* rather than a level. */
  private readonly devPeak = new Map<string, bigint>();

  constructor(private readonly pool: RpcPool) {}

  async audit(pos: Position): Promise<RugSignal[]> {
    if (pos.venue !== 'pumpfun') return [];
    const t0 = performance.now();
    try {
      return await this.auditPump(pos);
    } catch (err) {
      log.debug('audit failed', { mint: pos.mint, err });
      return [];
    } finally {
      metrics.observe('audit.cold', performance.now() - t0);
    }
  }

  private async auditPump(pos: Position): Promise<RugSignal[]> {
    const mint = new PublicKey(pos.mint);
    const curve = bondingCurvePda(mint);
    const targets: PublicKey[] = [curve];

    const creator = pos.creator ? new PublicKey(pos.creator) : null;
    if (creator) targets.push(ata(creator, mint));

    const infos = await this.pool.call(
      'getMultipleAccounts',
      (c) => c.getMultipleAccountsInfo(targets, { commitment: 'confirmed' }),
      4_000,
    );

    const out: RugSignal[] = [];
    const curveInfo = infos[0];
    if (!curveInfo) {
      out.push({ key: 'curve-vanished', detail: 'bonding curve account is gone', severity: 1 });
      return out;
    }

    const state = decodeBondingCurve(curveInfo.data);
    if (state.complete) {
      // Migration is not a rug, but the bonding-curve exit path stops working,
      // so the position has to be handed over before liquidity moves.
      out.push({
        key: 'curve-migrated',
        detail: 'curve completed; exit must route through the AMM',
        severity: 0.85,
      });
    }

    const devInfo = infos[1];
    if (creator && devInfo && devInfo.owner.equals(PROGRAMS.tokenProgram)) {
      const balance = decodeTokenAmount(devInfo.data);
      const peak = this.devPeak.get(pos.mint) ?? 0n;
      if (balance > peak) this.devPeak.set(pos.mint, balance);

      const share = state.tokenTotalSupply > 0n ? Number(balance) / Number(state.tokenTotalSupply) : 0;
      if (share > 0.15) {
        out.push({
          key: 'dev-holds-supply',
          detail: `creator holds ${(share * 100).toFixed(1)}% of supply`,
          severity: share > 0.3 ? 0.9 : 0.55,
        });
      }
      if (peak > 0n && balance < (peak * 70n) / 100n) {
        const sold = Number(peak - balance) / Number(peak);
        out.push({
          key: 'dev-selling',
          detail: `creator sold ${(sold * 100).toFixed(0)}% of their bag`,
          severity: sold > 0.6 ? 1 : 0.8,
        });
      }
    }

    return out;
  }

  forget(mint: string): void {
    this.devPeak.delete(mint);
  }
}
