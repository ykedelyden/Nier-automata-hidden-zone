import { clamp } from '../core/util.js';
import type { HotSignal, Verdict } from '../types.js';

/**
 * Relative importance of each signal family.
 *
 * Weights are deliberately asymmetric: safety signals (authorities, curve
 * state) count for more than cosmetic ones (metadata quality), because the
 * distribution of outcomes is fat-tailed on the downside. A pretty name has
 * never repaid a rug.
 */
const IMPORTANCE: Record<string, number> = {
  'freshness': 2.0,
  'curve-progress': 2.5,
  'price-impact': 2.0,
  'no-freeze': 1.5,
  'creator-reputation': 2.0,
  'launch-spam': 1.5,
  'creator-unknown': 0.8,
  'name-plausible': 0.5,
  'name-red-flag': 1.0,
  'symbol-odd': 0.5,
  'no-metadata-uri': 0.8,
  'no-mint-account': 1.0,
  'dev-holds-supply': 2.5,
  'holder-concentration': 2.0,
  'early-buyers': 1.2,
};

const DEFAULT_IMPORTANCE = 1.0;

/**
 * Collapses signals into a 0..1 score and a decision.
 *
 * The score is a weighted mean mapped from [-1,1] to [0,1], so a launch with no
 * signal at all sits at exactly 0.5 and is rejected by any sane `MIN_SCORE`.
 * Vetoes bypass the arithmetic entirely — they are not "very negative
 * evidence", they are disqualifying facts.
 */
export function score(signals: readonly HotSignal[], minScore: number): Verdict {
  const veto = signals.find((s) => s.veto === true);
  if (veto) {
    return {
      action: 'skip',
      score: 0,
      reasons: [`VETO ${veto.key}: ${veto.detail}`],
    };
  }

  if (signals.length === 0) {
    return { action: 'skip', score: 0.5, reasons: ['no signals produced'] };
  }

  let weighted = 0;
  let total = 0;
  for (const s of signals) {
    const importance = IMPORTANCE[s.key] ?? DEFAULT_IMPORTANCE;
    weighted += clamp(s.weight, -1, 1) * importance;
    total += importance;
  }
  const raw = total === 0 ? 0 : weighted / total;
  const normalised = clamp((raw + 1) / 2, 0, 1);

  const reasons = [...signals]
    .sort((a, b) => Math.abs(b.weight) * (IMPORTANCE[b.key] ?? 1) - Math.abs(a.weight) * (IMPORTANCE[a.key] ?? 1))
    .slice(0, 5)
    .map((s) => `${s.weight >= 0 ? '+' : '-'}${s.key}: ${s.detail}`);

  return normalised >= minScore
    ? { action: 'buy', score: normalised, reasons }
    : { action: 'skip', score: normalised, reasons: [...reasons, `score ${normalised.toFixed(3)} < ${minScore}`] };
}

/**
 * Converts a score into a position-size multiplier.
 *
 * A barely-passing launch gets a fraction of the configured size and a
 * high-conviction one gets the full amount. Sizing on conviction rather than
 * trading a fixed clip is what turns a positive-expectancy filter into a
 * positive-expectancy account.
 */
export function convictionMultiplier(scoreValue: number, minScore: number): number {
  if (scoreValue < minScore) return 0;
  const span = Math.max(1e-6, 1 - minScore);
  const t = clamp((scoreValue - minScore) / span, 0, 1);
  // 0.4x at the threshold, 1.0x at a perfect score, curved so that the middle
  // of the range is not treated as near-certainty.
  return 0.4 + 0.6 * t ** 1.5;
}
