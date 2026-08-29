import type { PublicKey } from '@solana/web3.js';

/** Where a launch was observed. Multiple sources can report the same mint. */
export type Venue = 'pumpfun' | 'raydium-amm4' | 'raydium-cpmm' | 'unknown';

/** Normalised launch event produced by every detector. */
export interface LaunchEvent {
  /** Monotonic id, unique per process. */
  readonly seq: number;
  readonly venue: Venue;
  readonly mint: string;
  /** Wallet that created the token / pool. */
  readonly creator: string | null;
  /** Signature of the create/init transaction. */
  readonly signature: string;
  /** Slot the create landed in, when the detector could read it. */
  readonly slot: number | null;
  /** Venue-specific accounts the executor needs (bonding curve, pool keys...). */
  readonly accounts: Record<string, string>;
  /** Curve/pool state as seen at detection time, when available for free. */
  readonly reserves: Reserves | null;
  /** `performance.now()` when the detector first saw the event. */
  readonly seenAt: number;
  /** Detector that won the race for this mint. */
  readonly detector: string;
  readonly metadata: TokenMetadata | null;
}

export interface TokenMetadata {
  readonly name: string | null;
  readonly symbol: string | null;
  readonly uri: string | null;
}

/** Constant-product reserves, in raw base units. */
export interface Reserves {
  readonly virtualSol: bigint;
  readonly virtualToken: bigint;
  readonly realSol: bigint;
  readonly realToken: bigint;
  readonly tokenTotalSupply: bigint;
  readonly complete: boolean;
}

export type Verdict =
  | { readonly action: 'buy'; readonly score: number; readonly reasons: string[] }
  | { readonly action: 'skip'; readonly score: number; readonly reasons: string[] };

export interface HotSignal {
  readonly key: string;
  /** -1..+1. Negative subtracts from the score. */
  readonly weight: number;
  readonly detail: string;
  /** A veto kills the trade regardless of total score. */
  readonly veto?: boolean;
}

export type PositionState =
  | 'pending-entry'
  | 'open'
  | 'exiting'
  | 'closed'
  | 'failed-entry';

export interface Position {
  id: string;
  mint: string;
  venue: Venue;
  creator: string | null;
  state: PositionState;
  /** Raw lamports actually spent on entry (excluding fees). */
  costLamports: bigint;
  /** Raw token base units held. */
  tokensRaw: bigint;
  tokenDecimals: number;
  entryPrice: number;
  peakPrice: number;
  lastPrice: number;
  /** Ladder rungs already taken, by index. */
  rungsHit: number[];
  /** Set once a partial de-risking exit has been taken, so it happens once. */
  derisked: boolean;
  openedAt: number;
  closedAt: number | null;
  realisedLamports: bigint;
  entrySignature: string | null;
  exitSignatures: string[];
  accounts: Record<string, string>;
  exitReason: string | null;
  /** Consecutive failures of the exit path; drives fee escalation. */
  exitAttempts: number;
}

export interface SendOutcome {
  readonly signature: string;
  /** Route that actually landed: which RPC or Jito region. */
  readonly route: string;
  readonly landedMs: number;
  readonly slot: number | null;
}

export interface QuoteResult {
  readonly tokensOut: bigint;
  readonly priceLamportsPerToken: number;
  readonly feeLamports: bigint;
}

export interface Executor {
  readonly venue: Venue;
  /** Build + send the entry. Must be latency-optimised. */
  buy(ev: LaunchEvent, lamports: bigint, owner: PublicKey): Promise<EntryResult>;
  /** Build + send an exit for `tokensRaw`. `urgency` escalates fees. */
  sell(pos: Position, tokensRaw: bigint, owner: PublicKey, urgency: number): Promise<SendOutcome>;
  /** Current mid price in lamports per whole token, for PnL tracking. */
  price(pos: Position): Promise<number>;
}

export interface EntryResult {
  readonly send: SendOutcome;
  readonly tokensRaw: bigint;
  readonly costLamports: bigint;
  readonly tokenDecimals: number;
  readonly entryPrice: number;
}
