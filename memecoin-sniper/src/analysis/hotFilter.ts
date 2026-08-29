import { PublicKey } from '@solana/web3.js';
import type { RpcPool } from '../chain/rpcPool.js';
import { bondingCurvePda } from '../chain/programs.js';
import type { Config } from '../config.js';
import { makeLogger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import { withTimeout } from '../core/util.js';
import { decodeBondingCurve, decodeMint } from '../exec/pumpfun/layout.js';
import { curveProgress, priceImpact } from '../exec/pumpfun/curve.js';
import type { HotSignal, LaunchEvent, Reserves } from '../types.js';
import type { ReputationStore } from './reputation.js';

const log = makeLogger('filter:hot');

/** Metadata patterns that correlate with copy-paste rug farms. */
const NAME_RED_FLAGS = [
  /\b(test|test123|asdf|qwerty)\b/i,
  /^[a-z]{1,2}$/i,
  /(airdrop|free\s?claim|1000x\s?guaranteed)/i,
  /\b(elon|trump|biden)\s?(inu|coin|2\.0|69|420)\b/i,
];

const NAME_GREEN_FLAGS = [/^[\p{L}\p{N} .'\-!?]{3,32}$/u];

export interface HotResult {
  readonly signals: HotSignal[];
  readonly reserves: Reserves | null;
  readonly decimals: number;
  readonly vetoed: boolean;
  readonly elapsedMs: number;
  readonly timedOut: boolean;
}

/**
 * Everything that can be decided before committing capital, under a hard time
 * budget.
 *
 * Two tiers run here. Tier 0 is pure local inspection of the launch event and
 * costs nothing. Tier 1 is a single raced `getMultipleAccounts` for the bonding
 * curve and the mint — roughly 30-60ms against a good provider — which is what
 * reveals retained mint/freeze authority and how much of the curve was bought
 * in the same block as the create.
 *
 * If tier 1 blows the budget the trade is abandoned rather than entered blind:
 * a snipe that arrives late has already lost its edge, so trading it with less
 * information is the worst of both worlds.
 */
export class HotFilter {
  constructor(
    private readonly pool: RpcPool,
    private readonly cfg: Config,
    private readonly reputation: ReputationStore,
  ) {}

  async evaluate(ev: LaunchEvent): Promise<HotResult> {
    const t0 = performance.now();
    const signals: HotSignal[] = [...this.tier0(ev)];
    let reserves: Reserves | null = null;
    let decimals = 6;
    let timedOut = false;

    const spent = performance.now() - t0;
    const remaining = this.cfg.HOT_FILTER_BUDGET_MS - spent;

    if (ev.venue === 'pumpfun' && remaining > 15) {
      try {
        const chain = await withTimeout(this.tier1(ev), remaining, 'hot.tier1');
        reserves = chain.reserves;
        decimals = chain.decimals;
        signals.push(...chain.signals);
      } catch (err) {
        timedOut = true;
        metrics.inc('filter.hot.timeout');
        signals.push({
          key: 'chain-read-timeout',
          weight: -1,
          detail: `on-chain read exceeded ${Math.round(remaining)}ms budget`,
          veto: true,
        });
        log.debug('tier1 aborted', { mint: ev.mint, err });
      }
    }

    const elapsedMs = performance.now() - t0;
    metrics.observe('filter.hot', elapsedMs);
    return {
      signals,
      reserves,
      decimals,
      vetoed: signals.some((s) => s.veto === true),
      elapsedMs,
      timedOut,
    };
  }

  /** Zero-RPC checks derived purely from the event payload. */
  private tier0(ev: LaunchEvent): HotSignal[] {
    const out: HotSignal[] = [];

    const ageMs = performance.now() - ev.seenAt;
    if (ageMs > this.cfg.MAX_EVENT_AGE_MS) {
      out.push({
        key: 'stale-event',
        weight: -1,
        detail: `event is ${Math.round(ageMs)}ms old`,
        veto: true,
      });
    } else {
      out.push({
        key: 'freshness',
        weight: 1 - ageMs / this.cfg.MAX_EVENT_AGE_MS,
        detail: `${Math.round(ageMs)}ms since detection`,
      });
    }

    if (ev.creator) {
      if (this.reputation.isBlacklisted(ev.creator)) {
        out.push({
          key: 'creator-blacklist',
          weight: -1,
          detail: 'creator wallet has rugged before',
          veto: true,
        });
      } else {
        const rep = this.reputation.score(ev.creator);
        if (rep !== 0) {
          out.push({ key: 'creator-reputation', weight: rep, detail: `reputation ${rep.toFixed(2)}` });
        }
      }
      const rec = this.reputation.get(ev.creator);
      if (rec && rec.launches >= 3) {
        const perDay = rec.launches / Math.max(1, (Date.now() - rec.firstSeen) / 86_400_000);
        if (perDay > 5) {
          out.push({
            key: 'launch-spam',
            weight: -0.6,
            detail: `${perDay.toFixed(1)} launches/day from this wallet`,
          });
        }
      }
    } else {
      out.push({ key: 'creator-unknown', weight: -0.3, detail: 'no creator in event payload' });
    }

    // The event reports the curve address; recomputing it locally catches a
    // spoofed or mis-parsed payload before any money moves.
    const claimed = ev.accounts['bondingCurve'];
    const derived = ev.accounts['derivedCurve'];
    if (claimed && derived && claimed !== derived) {
      out.push({
        key: 'curve-mismatch',
        weight: -1,
        detail: 'event bonding curve does not match the derived PDA',
        veto: true,
      });
    }

    out.push(...this.metadataSignals(ev));
    return out;
  }

  private metadataSignals(ev: LaunchEvent): HotSignal[] {
    const out: HotSignal[] = [];
    const meta = ev.metadata;
    if (!meta) return out;

    const name = meta.name ?? '';
    const symbol = meta.symbol ?? '';

    for (const rx of NAME_RED_FLAGS) {
      if (rx.test(name) || rx.test(symbol)) {
        out.push({ key: 'name-red-flag', weight: -0.5, detail: `matched ${rx.source}` });
        break;
      }
    }
    if (NAME_GREEN_FLAGS.some((rx) => rx.test(name))) {
      out.push({ key: 'name-plausible', weight: 0.15, detail: 'name looks human-written' });
    }
    if (symbol.length === 0 || symbol.length > 10) {
      out.push({ key: 'symbol-odd', weight: -0.25, detail: `symbol length ${symbol.length}` });
    }
    if (!meta.uri || !/^https?:\/\//.test(meta.uri)) {
      out.push({ key: 'no-metadata-uri', weight: -0.35, detail: 'missing or non-http metadata uri' });
    }
    // Invisible characters are a standard trick for impersonating a live ticker.
    if (/[\u200B-\u200F\u202A-\u202E\uFEFF]/.test(name + symbol)) {
      out.push({
        key: 'hidden-chars',
        weight: -1,
        detail: 'name contains zero-width or bidi control characters',
        veto: true,
      });
    }
    return out;
  }

  /** One raced multi-account read: bonding curve + mint in a single request. */
  private async tier1(ev: LaunchEvent): Promise<{
    signals: HotSignal[];
    reserves: Reserves | null;
    decimals: number;
  }> {
    const mint = new PublicKey(ev.mint);
    const curve = bondingCurvePda(mint);
    const infos = await this.pool.race(
      'getMultipleAccounts',
      (c) => c.getMultipleAccountsInfo([curve, mint], { commitment: 'processed' }),
      Math.max(20, this.cfg.HOT_FILTER_BUDGET_MS),
    );

    const signals: HotSignal[] = [];
    const curveInfo = infos[0];
    const mintInfo = infos[1];

    if (!curveInfo) {
      return {
        signals: [
          { key: 'no-curve', weight: -1, detail: 'bonding curve account not found yet', veto: true },
        ],
        reserves: null,
        decimals: 6,
      };
    }

    const curveState = decodeBondingCurve(curveInfo.data);
    if (curveState.complete) {
      signals.push({
        key: 'curve-complete',
        weight: -1,
        detail: 'bonding curve already migrated',
        veto: true,
      });
    }

    const progress = curveProgress(curveState);
    signals.push({
      key: 'curve-progress',
      // Untouched is ideal; a curve already 25%+ eaten means the snipe is late.
      weight: progress < 0.02 ? 0.6 : progress < 0.1 ? 0.2 : progress < 0.25 ? -0.2 : -0.8,
      detail: `${(progress * 100).toFixed(2)}% of supply already sold`,
    });

    const impact = priceImpact(curveState, BigInt(this.cfg.BUY_LAMPORTS));
    signals.push({
      key: 'price-impact',
      weight: impact < 0.03 ? 0.4 : impact < 0.08 ? 0.1 : impact < 0.2 ? -0.4 : -1,
      detail: `${(impact * 100).toFixed(2)}% impact for the configured size`,
      ...(impact >= 0.35 ? { veto: true } : {}),
    });

    let decimals = 6;
    if (mintInfo) {
      const m = decodeMint(mintInfo.data);
      decimals = m.decimals;
      if (m.freezeAuthority) {
        signals.push({
          key: 'freeze-authority',
          weight: -1,
          detail: `freeze authority retained by ${m.freezeAuthority.toBase58().slice(0, 8)}`,
          veto: true,
        });
      } else {
        signals.push({ key: 'no-freeze', weight: 0.25, detail: 'freeze authority renounced' });
      }
      // On pump.fun the curve PDA legitimately holds mint authority until
      // migration; any *other* holder means arbitrary supply inflation.
      if (m.mintAuthority && !m.mintAuthority.equals(curve)) {
        signals.push({
          key: 'mint-authority',
          weight: -1,
          detail: `mint authority held by ${m.mintAuthority.toBase58().slice(0, 8)}`,
          veto: true,
        });
      }
    } else {
      signals.push({ key: 'no-mint-account', weight: -0.5, detail: 'mint account not visible yet' });
    }

    return {
      signals,
      reserves: {
        virtualSol: curveState.virtualSol,
        virtualToken: curveState.virtualToken,
        realSol: curveState.realSol,
        realToken: curveState.realToken,
        tokenTotalSupply: curveState.tokenTotalSupply,
        complete: curveState.complete,
      },
      decimals,
    };
  }
}
