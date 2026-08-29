import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { RiskEngine } from '../src/risk/riskEngine.js';
import { testConfig } from './helpers.js';

describe('risk engine', () => {
  test('sizes on conviction, never above the base clip', () => {
    const cfg = testConfig();
    const risk = new RiskEngine(cfg);
    risk.setWalletBalance(1_000_000_000n);

    const weak = risk.approve(0.56, 0);
    const strong = risk.approve(0.99, 0);
    assert.ok(weak.allowed && strong.allowed);
    assert.ok(weak.lamports < strong.lamports);
    assert.ok(strong.lamports <= BigInt(cfg.BUY_LAMPORTS));
  });

  test('refuses anything below the score threshold', () => {
    const risk = new RiskEngine(testConfig());
    risk.setWalletBalance(1_000_000_000n);
    const d = risk.approve(0.2, 0);
    assert.equal(d.allowed, false);
  });

  test('enforces the concurrent position cap', () => {
    const cfg = testConfig({ MAX_CONCURRENT_POSITIONS: 2 });
    const risk = new RiskEngine(cfg);
    risk.setWalletBalance(1_000_000_000n);
    assert.equal(risk.approve(0.9, 2).allowed, false);
    assert.equal(risk.approve(0.9, 1).allowed, true);
  });

  test('clamps a trade to the remaining exposure headroom', () => {
    const cfg = testConfig({ MAX_EXPOSURE_LAMPORTS: 30_000_000, MAX_CONCURRENT_POSITIONS: 10 });
    const risk = new RiskEngine(cfg);
    risk.setWalletBalance(1_000_000_000n);

    const first = risk.approve(1, 0);
    assert.ok(first.allowed);
    assert.equal(first.lamports, 20_000_000n);
    risk.reserve(first.lamports);

    // 10m of headroom left: the trade is taken, but sized down to fit.
    const second = risk.approve(1, 1);
    assert.ok(second.allowed);
    assert.equal(second.lamports, 10_000_000n);
  });

  test('refuses a clip too small to be worth its fees', () => {
    const cfg = testConfig({ MAX_EXPOSURE_LAMPORTS: 24_000_000, MAX_CONCURRENT_POSITIONS: 10 });
    const risk = new RiskEngine(cfg);
    risk.setWalletBalance(1_000_000_000n);

    const first = risk.approve(1, 0);
    assert.ok(first.allowed);
    risk.reserve(first.lamports);

    // 4m of headroom is under the 5m floor (25% of the base clip).
    const second = risk.approve(1, 1);
    assert.equal(second.allowed, false);
    assert.match(second.reason, /floor/);
  });

  test('never spends into the wallet reserve', () => {
    const cfg = testConfig({ MIN_WALLET_RESERVE_LAMPORTS: 30_000_000 });
    const risk = new RiskEngine(cfg);
    risk.setWalletBalance(31_000_000n);
    const d = risk.approve(1, 0);
    // 1m lamports spendable is far below the floor, so this must be refused.
    assert.equal(d.allowed, false);
  });

  test('halts for the day once the loss limit is breached', () => {
    const cfg = testConfig({ DAILY_LOSS_LIMIT_LAMPORTS: 50_000_000 });
    const risk = new RiskEngine(cfg);
    risk.setWalletBalance(1_000_000_000n);

    risk.reserve(20_000_000n);
    risk.settle(20_000_000n, -60_000_000n);

    assert.equal(risk.isHalted, true);
    assert.equal(risk.approve(1, 0).allowed, false);
  });

  test('cools down after a losing streak, then resumes', () => {
    const cfg = testConfig({ CONSECUTIVE_LOSS_COOLDOWN: 3, COOLDOWN_MS: 60_000 });
    const risk = new RiskEngine(cfg);
    risk.setWalletBalance(1_000_000_000n);

    for (let i = 0; i < 3; i++) {
      risk.reserve(10_000_000n);
      risk.settle(10_000_000n, -1_000_000n);
    }
    const blocked = risk.approve(1, 0);
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason, /cooling down/);

    risk.resume();
    assert.equal(risk.approve(1, 0).allowed, true);
  });

  test('a win resets the losing streak', () => {
    const cfg = testConfig({ CONSECUTIVE_LOSS_COOLDOWN: 3, COOLDOWN_MS: 60_000 });
    const risk = new RiskEngine(cfg);
    risk.setWalletBalance(1_000_000_000n);

    risk.reserve(10_000_000n);
    risk.settle(10_000_000n, -1_000_000n);
    risk.reserve(10_000_000n);
    risk.settle(10_000_000n, -1_000_000n);
    risk.reserve(10_000_000n);
    risk.settle(10_000_000n, 5_000_000n); // win
    risk.reserve(10_000_000n);
    risk.settle(10_000_000n, -1_000_000n);

    assert.equal(risk.approve(1, 0).allowed, true, 'streak should have reset on the win');
  });

  test('settling releases the reservation', () => {
    const risk = new RiskEngine(testConfig());
    risk.setWalletBalance(1_000_000_000n);
    risk.reserve(20_000_000n);
    assert.equal(risk.status().openExposure, '0.0200');
    risk.settle(20_000_000n, 1_000_000n);
    assert.equal(risk.status().openExposure, '0.0000');
  });

  test('release cannot drive exposure negative', () => {
    const risk = new RiskEngine(testConfig());
    risk.release(999_000_000n);
    assert.equal(risk.status().openExposure, '0.0000');
  });

  test('a manual halt blocks everything until resumed', () => {
    const risk = new RiskEngine(testConfig());
    risk.setWalletBalance(1_000_000_000n);
    risk.halt('operator');
    const d = risk.approve(1, 0);
    assert.equal(d.allowed, false);
    assert.match(d.reason, /halted: operator/);
    risk.resume();
    assert.equal(risk.approve(1, 0).allowed, true);
  });
});
