import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import {
  applyBuy,
  curveProgress,
  grossUpBuy,
  priceImpact,
  solForTokens,
  solForTokensGross,
  spotPrice,
  tokensForSol,
} from '../src/exec/pumpfun/curve.js';
import type { Reserves } from '../src/types.js';

/** A freshly created pump.fun curve, at the program's standard seed values. */
const FRESH: Reserves = {
  virtualSol: 30_000_000_000n,
  virtualToken: 1_073_000_000_000_000n,
  realSol: 0n,
  realToken: 793_100_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
};

describe('bonding curve quotes', () => {
  test('a buy moves along the constant product', () => {
    const solIn = 1_000_000_000n; // 1 SOL
    const out = tokensForSol(FRESH, solIn);
    assert.ok(out > 0n, 'must return tokens');

    // k should be preserved (up to the program's +1 rounding in its favour).
    const after = applyBuy(FRESH, solIn, out);
    const kBefore = FRESH.virtualSol * FRESH.virtualToken;
    const kAfter = after.virtualSol * after.virtualToken;
    assert.ok(kAfter >= kBefore, 'the pool must never lose value to rounding');
  });

  test('rounding favours the pool, never the buyer', () => {
    const solIn = 123_456_789n;
    const out = tokensForSol(FRESH, solIn);
    const ideal =
      FRESH.virtualToken - (FRESH.virtualSol * FRESH.virtualToken) / (FRESH.virtualSol + solIn);
    assert.ok(out <= ideal, `quote ${out} must not exceed the exact value ${ideal}`);
  });

  test('output is monotonic and concave in the input', () => {
    // Equal increments, so the deltas are directly comparable.
    const a = tokensForSol(FRESH, 1_000_000_000n);
    const b = tokensForSol(FRESH, 2_000_000_000n);
    const c = tokensForSol(FRESH, 3_000_000_000n);
    assert.ok(b > a && c > b, 'more SOL must buy more tokens');
    assert.ok(b - a > c - b, 'each equal-sized increment must buy strictly fewer tokens');
  });

  test('the curve never sells more than it physically holds', () => {
    const thin: Reserves = { ...FRESH, realToken: 1_000n };
    assert.equal(tokensForSol(thin, 500_000_000_000n), 1_000n);
  });

  test('a completed curve quotes zero', () => {
    assert.equal(tokensForSol({ ...FRESH, complete: true }, 1_000_000_000n), 0n);
  });

  test('non-positive input quotes zero', () => {
    assert.equal(tokensForSol(FRESH, 0n), 0n);
    assert.equal(tokensForSol(FRESH, -5n), 0n);
    assert.equal(solForTokens(FRESH, 0n), 0n);
  });

  test('the sell fee is exactly 100 bps of the gross', () => {
    const tokens = 5_000_000_000n;
    const gross = solForTokensGross(FRESH, tokens);
    const net = solForTokens(FRESH, tokens);
    assert.equal(gross - net, gross / 100n);
  });

  test('a buy followed by an immediate sell loses roughly the round-trip fee', () => {
    const solIn = 500_000_000n;
    const tokens = tokensForSol(FRESH, solIn);
    const after = applyBuy(FRESH, solIn, tokens);
    const back = solForTokens(after, tokens);

    assert.ok(back < solIn, 'a round trip must never be profitable');
    // Two 1% legs plus curve rounding; anything worse means the math is wrong.
    const lossBps = Number(((solIn - back) * 10_000n) / solIn);
    assert.ok(lossBps < 250, `round-trip loss ${lossBps}bps is larger than the fee explains`);
  });

  test('grossUpBuy adds the protocol fee on top of the curve input', () => {
    assert.equal(grossUpBuy(1_000_000n), 1_010_000n);
  });

  test('price impact grows with size', () => {
    const small = priceImpact(FRESH, 10_000_000n);
    const large = priceImpact(FRESH, 10_000_000_000n);
    assert.ok(small < large);
    assert.ok(small < 0.01, `a 0.01 SOL buy should barely move a fresh curve, got ${small}`);
    assert.ok(large > 0.1, `a 10 SOL buy should move it hard, got ${large}`);
  });

  test('curve progress tracks tokens sold out of total supply', () => {
    assert.ok(Math.abs(curveProgress(FRESH) - 0.2069) < 0.001);
    assert.equal(curveProgress({ ...FRESH, realToken: FRESH.tokenTotalSupply }), 0);
    assert.equal(curveProgress({ ...FRESH, realToken: 0n }), 1);
  });

  test('spot price is expressed per whole token', () => {
    const price = spotPrice(FRESH, 6);
    // 30 SOL of virtual reserves against ~1.073e9 whole tokens.
    assert.ok(price > 20 && price < 40, `unexpected spot price ${price}`);
  });

  test('spot price of an empty curve is zero rather than NaN', () => {
    assert.equal(spotPrice({ ...FRESH, virtualToken: 0n }, 6), 0);
  });
});
