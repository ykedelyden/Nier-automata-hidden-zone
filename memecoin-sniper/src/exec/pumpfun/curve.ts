import type { Reserves } from '../../types.js';

/** pump.fun charges 100 bps on both sides of a bonding-curve trade. */
export const PUMP_FEE_BPS = 100n;
const BPS = 10_000n;

/**
 * Exact port of the on-chain constant-product buy quote.
 *
 * The program computes `k = vSol * vToken`, applies the incoming SOL to the
 * SOL side, and hands back the token delta — with a `+1` that rounds in the
 * pool's favour. Reproducing the rounding exactly matters: a quote that is one
 * unit optimistic makes the transaction revert on `max_sol_cost`.
 */
export function tokensForSol(reserves: Reserves, solIn: bigint): bigint {
  if (solIn <= 0n) return 0n;
  if (reserves.complete) return 0n;
  const k = reserves.virtualSol * reserves.virtualToken;
  const newSol = reserves.virtualSol + solIn;
  const newToken = k / newSol + 1n;
  const out = reserves.virtualToken > newToken ? reserves.virtualToken - newToken : 0n;
  // The curve can never sell more than it physically holds.
  return out < reserves.realToken ? out : reserves.realToken;
}

/** Gross SOL (before fee) returned for selling `tokensIn` into the curve. */
export function solForTokensGross(reserves: Reserves, tokensIn: bigint): bigint {
  if (tokensIn <= 0n) return 0n;
  const denom = reserves.virtualToken + tokensIn;
  if (denom === 0n) return 0n;
  return (tokensIn * reserves.virtualSol) / denom;
}

/** Net SOL after the protocol fee — what actually reaches the wallet. */
export function solForTokens(reserves: Reserves, tokensIn: bigint): bigint {
  const gross = solForTokensGross(reserves, tokensIn);
  return gross - (gross * PUMP_FEE_BPS) / BPS;
}

/** SOL the buyer must send so that `solIn` reaches the curve after the fee. */
export function grossUpBuy(solIn: bigint): bigint {
  return solIn + (solIn * PUMP_FEE_BPS) / BPS;
}

/**
 * Spot price in lamports per whole token. Used for PnL and stop logic only —
 * never for sizing a trade, which must go through `tokensForSol`.
 */
export function spotPrice(reserves: Reserves, decimals: number): number {
  if (reserves.virtualToken === 0n) return 0;
  const scale = 10 ** decimals;
  return (Number(reserves.virtualSol) / Number(reserves.virtualToken)) * scale;
}

/** Fraction of the bonding curve already sold — the classic "progress" bar. */
export function curveProgress(reserves: Reserves): number {
  if (reserves.tokenTotalSupply === 0n) return 0;
  const sold = reserves.tokenTotalSupply - reserves.realToken;
  return Math.min(1, Math.max(0, Number(sold) / Number(reserves.tokenTotalSupply)));
}

/**
 * Price impact of `solIn` as a fraction, comparing the average fill price to
 * the pre-trade spot price. A launch where a modest buy moves price 40%+ has a
 * curve too thin to exit through.
 */
export function priceImpact(reserves: Reserves, solIn: bigint): number {
  const out = tokensForSol(reserves, solIn);
  if (out === 0n) return 1;
  const avg = Number(solIn) / Number(out);
  const spot = Number(reserves.virtualSol) / Number(reserves.virtualToken);
  if (spot === 0) return 1;
  return Math.max(0, avg / spot - 1);
}

/** Applies a fill to a local copy of the reserves, for multi-step simulation. */
export function applyBuy(reserves: Reserves, solIn: bigint, tokensOut: bigint): Reserves {
  return {
    ...reserves,
    virtualSol: reserves.virtualSol + solIn,
    virtualToken: reserves.virtualToken - tokensOut,
    realSol: reserves.realSol + solIn,
    realToken: reserves.realToken - tokensOut,
  };
}
