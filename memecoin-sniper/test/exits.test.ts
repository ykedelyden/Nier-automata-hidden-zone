import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import type { RugSignal } from '../src/analysis/coldAudit.js';
import { PositionManager } from '../src/position/manager.js';
import type { Config } from '../src/config.js';
import { testConfig, testPosition } from './helpers.js';

/**
 * `decide` reads only the config, so the remaining collaborators can be left
 * unbuilt. This keeps the exit-policy tests free of filesystem and RPC setup.
 */
function managerFor(cfg: Config): PositionManager {
  const nothing = undefined as never;
  return new PositionManager(cfg, nothing, nothing, nothing, nothing, nothing, nothing);
}

const RUG: RugSignal[] = [{ key: 'dev-selling', detail: 'creator sold 80%', severity: 1 }];
const MILD: RugSignal[] = [{ key: 'dev-holds-supply', detail: 'creator holds 20%', severity: 0.55 }];

describe('exit policy', () => {
  test('does nothing while the position sits inside every band', () => {
    const m = managerFor(testConfig());
    const pos = testPosition({ lastPrice: 105, peakPrice: 110 });
    assert.equal(m.decide(pos), null);
  });

  test('a severe rug signal forces a full exit at maximum urgency', () => {
    const m = managerFor(testConfig());
    // Deliberately a *winning* position: a rug beats a profit.
    const pos = testPosition({ lastPrice: 400, peakPrice: 400 });
    const plan = m.decide(pos, RUG);
    assert.ok(plan);
    assert.equal(plan.fraction, 1);
    assert.equal(plan.urgency, 4);
    assert.match(plan.reason, /^rug:dev-selling/);
  });

  test('the hard stop fires below the pain threshold', () => {
    const m = managerFor(testConfig({ HARD_STOP_PCT: 0.45 }));
    const plan = m.decide(testPosition({ lastPrice: 54, peakPrice: 100 }));
    assert.ok(plan);
    assert.equal(plan.fraction, 1);
    assert.match(plan.reason, /hard stop/);
  });

  test('the hard stop does not fire one tick above the threshold', () => {
    const m = managerFor(testConfig({ HARD_STOP_PCT: 0.45 }));
    assert.equal(m.decide(testPosition({ lastPrice: 56, peakPrice: 100 })), null);
  });

  test('the trailing stop stays disarmed until the trade is meaningfully up', () => {
    const cfg = testConfig({ TRAILING_ARM_MULTIPLE: 1.4, TRAILING_STOP_PCT: 0.28 });
    const m = managerFor(cfg);
    // Peaked at 1.3x then fell 30% off that peak — but never armed.
    const pos = testPosition({ peakPrice: 130, lastPrice: 91 });
    assert.equal(m.decide(pos), null, 'an early wick must not stop out a fresh entry');
  });

  test('the trailing stop fires once armed and given back enough', () => {
    const cfg = testConfig({ TRAILING_ARM_MULTIPLE: 1.4, TRAILING_STOP_PCT: 0.28 });
    const m = managerFor(cfg);
    const pos = testPosition({ peakPrice: 300, lastPrice: 200 }); // -33% off peak
    const plan = m.decide(pos);
    assert.ok(plan);
    assert.equal(plan.fraction, 1);
    assert.match(plan.reason, /trailing stop/);
  });

  test('take-profit takes the highest rung a violent move cleared', () => {
    const m = managerFor(testConfig());
    // Straight to 6x: must take rung 2 (5x), not rung 0 (1.6x).
    const plan = m.decide(testPosition({ lastPrice: 600, peakPrice: 600 }));
    assert.ok(plan);
    assert.equal(plan.rungIndex, 2);
    assert.equal(plan.fraction, 0.2);
  });

  test('a rung already taken is not taken twice', () => {
    const m = managerFor(testConfig());
    const pos = testPosition({ lastPrice: 170, peakPrice: 170, rungsHit: [0] });
    // 1.7x only clears rung 0, which is spent; nothing else applies yet.
    assert.equal(m.decide(pos), null);
  });

  test('a rug beats a take-profit at the same instant', () => {
    const m = managerFor(testConfig());
    const plan = m.decide(testPosition({ lastPrice: 600, peakPrice: 600 }), RUG);
    assert.ok(plan);
    assert.equal(plan.fraction, 1);
    assert.match(plan.reason, /^rug:/);
  });

  test('max hold closes a position that overstayed', () => {
    const m = managerFor(testConfig({ MAX_HOLD_MS: 60_000 }));
    const pos = testPosition({ openedAt: Date.now() - 61_000, lastPrice: 120, peakPrice: 125 });
    const plan = m.decide(pos);
    assert.ok(plan);
    assert.match(plan.reason, /max hold/);
  });

  test('stagnation closes a flat position that ties up capital', () => {
    const m = managerFor(testConfig({ STAGNATION_MS: 30_000, STAGNATION_BAND_PCT: 0.08 }));
    const pos = testPosition({ openedAt: Date.now() - 31_000, lastPrice: 103, peakPrice: 104 });
    const plan = m.decide(pos);
    assert.ok(plan);
    assert.match(plan.reason, /stagnant/);
    assert.equal(plan.urgency, 0, 'a flat exit is not urgent');
  });

  test('a moving position is not treated as stagnant', () => {
    const m = managerFor(testConfig({ STAGNATION_MS: 30_000, STAGNATION_BAND_PCT: 0.08 }));
    const pos = testPosition({ openedAt: Date.now() - 31_000, lastPrice: 125, peakPrice: 125 });
    const plan = m.decide(pos);
    // 1.25x is outside the flat band and below the first rung: hold.
    assert.equal(plan, null);
  });

  test('a mild signal de-risks half the bag exactly once', () => {
    const m = managerFor(testConfig());
    const pos = testPosition({ lastPrice: 105, peakPrice: 110 });
    const first = m.decide(pos, MILD);
    assert.ok(first);
    assert.equal(first.fraction, 0.5);
    assert.equal(first.derisk, true);

    assert.equal(m.decide({ ...pos, derisked: true }, MILD), null);
  });

  test('decide never mutates the position it inspects', () => {
    const m = managerFor(testConfig());
    const pos = testPosition({ lastPrice: 600, peakPrice: 600 });
    const before = JSON.stringify(pos, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    m.decide(pos, MILD);
    const after = JSON.stringify(pos, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    assert.equal(before, after);
  });

  test('an unfilled or already-sold position produces no plan', () => {
    const m = managerFor(testConfig());
    assert.equal(m.decide(testPosition({ entryPrice: 0 })), null);
    assert.equal(m.decide(testPosition({ tokensRaw: 0n })), null);
  });
});
