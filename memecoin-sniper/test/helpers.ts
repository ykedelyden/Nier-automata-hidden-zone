import type { Config } from '../src/config.js';
import type { Position } from '../src/types.js';

/** A complete config with sane defaults, overridable per test. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = {
    MODE: 'paper',
    LOG_LEVEL: 'error',
    RPC_HTTP: ['https://example.invalid'],
    RPC_WS: [],
    SEND_RPC_HTTP: [],
    JITO_ENDPOINTS: [],
    JITO_TIP_LAMPORTS: 200_000,
    JITO_ENABLED: false,
    WALLET_SECRET: undefined,
    WATCH_PUMPFUN: true,
    WATCH_RAYDIUM: false,
    HOT_FILTER_BUDGET_MS: 120,
    BUY_LAMPORTS: 20_000_000,
    BUY_SLIPPAGE_BPS: 1500,
    MAX_CONCURRENT_POSITIONS: 3,
    MAX_EVENT_AGE_MS: 2_500,
    MIN_SCORE: 0.55,
    CU_LIMIT_BUY: 120_000,
    CU_LIMIT_SELL: 140_000,
    PRIORITY_FEE_MICROLAMPORTS: 500_000,
    PRIORITY_FEE_MAX_MICROLAMPORTS: 8_000_000,
    TP_LADDER: ['1.6:0.35', '2.5:0.3', '5:0.2', '10:0.15'],
    TRAILING_STOP_PCT: 0.28,
    TRAILING_ARM_MULTIPLE: 1.4,
    HARD_STOP_PCT: 0.45,
    MAX_HOLD_MS: 180_000,
    STAGNATION_MS: 45_000,
    STAGNATION_BAND_PCT: 0.08,
    PRICE_POLL_MS: 700,
    DAILY_LOSS_LIMIT_LAMPORTS: 300_000_000,
    MAX_EXPOSURE_LAMPORTS: 120_000_000,
    CONSECUTIVE_LOSS_COOLDOWN: 3,
    COOLDOWN_MS: 300_000,
    MIN_WALLET_RESERVE_LAMPORTS: 30_000_000,
    STATE_DIR: './state',
    tpLadder: [
      { multiple: 1.6, fraction: 0.35 },
      { multiple: 2.5, fraction: 0.3 },
      { multiple: 5, fraction: 0.2 },
      { multiple: 10, fraction: 0.15 },
    ],
  } as unknown as Config;
  return { ...base, ...overrides } as Config;
}

export function testPosition(overrides: Partial<Position> = {}): Position {
  const base: Position = {
    id: 'test',
    mint: 'MintMintMintMintMintMintMintMintMintMintMint',
    venue: 'pumpfun',
    creator: 'CreatorCreatorCreatorCreatorCreatorCreator',
    state: 'open',
    costLamports: 20_000_000n,
    tokensRaw: 1_000_000_000n,
    tokenDecimals: 6,
    entryPrice: 100,
    peakPrice: 100,
    lastPrice: 100,
    rungsHit: [],
    derisked: false,
    openedAt: Date.now(),
    closedAt: null,
    realisedLamports: 0n,
    entrySignature: 'sig',
    exitSignatures: [],
    accounts: {},
    exitReason: null,
    exitAttempts: 0,
  };
  return { ...base, ...overrides };
}
