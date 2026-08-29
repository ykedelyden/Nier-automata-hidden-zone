import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { convictionMultiplier, score } from '../src/analysis/scorer.js';
import type { HotSignal } from '../src/types.js';

const MIN = 0.55;

describe('scorer', () => {
  test('a veto beats every positive signal', () => {
    const signals: HotSignal[] = [
      { key: 'freshness', weight: 1, detail: 'instant' },
      { key: 'no-freeze', weight: 1, detail: 'renounced' },
      { key: 'curve-progress', weight: 1, detail: 'untouched' },
      { key: 'freeze-authority', weight: -1, detail: 'retained', veto: true },
    ];
    const v = score(signals, MIN);
    assert.equal(v.action, 'skip');
    assert.equal(v.score, 0);
    assert.match(v.reasons[0]!, /^VETO freeze-authority/);
  });

  test('no signals is a skip, not a neutral pass', () => {
    const v = score([], MIN);
    assert.equal(v.action, 'skip');
  });

  test('an all-neutral launch lands at exactly 0.5', () => {
    const v = score([{ key: 'freshness', weight: 0, detail: 'x' }], MIN);
    assert.equal(v.score, 0.5);
    assert.equal(v.action, 'skip', '0.5 must not clear a 0.55 threshold');
  });

  test('strong positives clear the threshold', () => {
    const signals: HotSignal[] = [
      { key: 'freshness', weight: 0.9, detail: '80ms' },
      { key: 'curve-progress', weight: 0.6, detail: '0.5% sold' },
      { key: 'price-impact', weight: 0.4, detail: '2%' },
      { key: 'no-freeze', weight: 0.25, detail: 'renounced' },
    ];
    const v = score(signals, MIN);
    assert.equal(v.action, 'buy');
    assert.ok(v.score > MIN);
  });

  test('safety signals outweigh cosmetic ones', () => {
    const cosmeticGood = score(
      [
        { key: 'name-plausible', weight: 1, detail: 'nice name' },
        { key: 'curve-progress', weight: -1, detail: '40% already sold' },
      ],
      MIN,
    );
    assert.equal(cosmeticGood.action, 'skip', 'a pretty name cannot rescue a late entry');
  });

  test('weights outside [-1,1] are clamped rather than trusted', () => {
    const a = score([{ key: 'freshness', weight: 50, detail: 'x' }], MIN);
    const b = score([{ key: 'freshness', weight: 1, detail: 'x' }], MIN);
    assert.equal(a.score, b.score);
  });

  test('reasons are ranked by contribution and capped', () => {
    const signals: HotSignal[] = Array.from({ length: 12 }, (_, i) => ({
      key: `k${i}`,
      weight: i / 12,
      detail: `d${i}`,
    }));
    const v = score(signals, MIN);
    assert.ok(v.reasons.length <= 6);
  });
});

describe('conviction sizing', () => {
  test('below the threshold sizes to zero', () => {
    assert.equal(convictionMultiplier(0.4, MIN), 0);
  });

  test('at the threshold it takes a reduced clip', () => {
    assert.ok(Math.abs(convictionMultiplier(MIN, MIN) - 0.4) < 1e-9);
  });

  test('a perfect score takes the full clip', () => {
    assert.ok(Math.abs(convictionMultiplier(1, MIN) - 1) < 1e-9);
  });

  test('it is monotonic in the score', () => {
    let prev = -1;
    for (let s = MIN; s <= 1.0001; s += 0.05) {
      const m = convictionMultiplier(Math.min(s, 1), MIN);
      assert.ok(m >= prev, `not monotonic at ${s}`);
      prev = m;
    }
  });

  test('the middle of the range is sized conservatively', () => {
    const mid = convictionMultiplier((1 + MIN) / 2, MIN);
    assert.ok(mid < 0.75, `midpoint multiplier ${mid} is too aggressive`);
  });
});
