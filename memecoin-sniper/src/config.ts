import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const csv = (fallback: string[] = []) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? fallback
        : v.split(',').map((s) => s.trim()).filter(Boolean),
    );

const num = (fallback: number) =>
  z.coerce.number().optional().transform((v) => (v === undefined || Number.isNaN(v) ? fallback : v));

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v)));

const Schema = z.object({
  // ---- mode -------------------------------------------------------------
  /** `paper` never signs a transaction. It is the default on purpose. */
  MODE: z.enum(['paper', 'live']).default('paper'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  // ---- connectivity -----------------------------------------------------
  RPC_HTTP: csv(['https://api.mainnet-beta.solana.com']),
  RPC_WS: csv([]),
  /** Endpoints used only to broadcast. Racing several is the whole point. */
  SEND_RPC_HTTP: csv([]),
  JITO_ENDPOINTS: csv([]),
  JITO_TIP_LAMPORTS: num(200_000),
  JITO_ENABLED: bool(false),

  // ---- wallet -----------------------------------------------------------
  /** base58 secret key, or a path to a JSON keypair array. */
  WALLET_SECRET: z.string().optional(),

  // ---- detection --------------------------------------------------------
  WATCH_PUMPFUN: bool(true),
  WATCH_RAYDIUM: bool(true),
  /** Hard budget for the pre-trade filter. Exceeding it aborts the snipe. */
  HOT_FILTER_BUDGET_MS: num(120),

  // ---- entry ------------------------------------------------------------
  BUY_LAMPORTS: num(20_000_000), // 0.02 SOL
  BUY_SLIPPAGE_BPS: num(1500),
  MAX_CONCURRENT_POSITIONS: num(3),
  /** Skip anything older than this at detection time (stale websocket replay). */
  MAX_EVENT_AGE_MS: num(2_500),
  MIN_SCORE: num(0.55),

  // ---- fees -------------------------------------------------------------
  CU_LIMIT_BUY: num(120_000),
  CU_LIMIT_SELL: num(140_000),
  PRIORITY_FEE_MICROLAMPORTS: num(500_000),
  PRIORITY_FEE_MAX_MICROLAMPORTS: num(8_000_000),

  // ---- exits ------------------------------------------------------------
  /** "gain_multiple:fraction_of_bag" rungs, applied in order. */
  TP_LADDER: csv(['1.6:0.35', '2.5:0.3', '5:0.2', '10:0.15']),
  TRAILING_STOP_PCT: num(0.28),
  /** Trailing only arms once the position is up this much. */
  TRAILING_ARM_MULTIPLE: num(1.4),
  HARD_STOP_PCT: num(0.45),
  MAX_HOLD_MS: num(180_000),
  /** Bail out early if the position has not moved at all. */
  STAGNATION_MS: num(45_000),
  STAGNATION_BAND_PCT: num(0.08),
  PRICE_POLL_MS: num(700),

  // ---- risk -------------------------------------------------------------
  DAILY_LOSS_LIMIT_LAMPORTS: num(300_000_000), // 0.3 SOL
  MAX_EXPOSURE_LAMPORTS: num(120_000_000),
  CONSECUTIVE_LOSS_COOLDOWN: num(3),
  COOLDOWN_MS: num(300_000),
  MIN_WALLET_RESERVE_LAMPORTS: num(30_000_000),

  // ---- persistence ------------------------------------------------------
  STATE_DIR: z.string().default('./state'),
});

export type Config = z.infer<typeof Schema> & {
  readonly tpLadder: ReadonlyArray<{ multiple: number; fraction: number }>;
};

function parseLadder(raw: string[]): Array<{ multiple: number; fraction: number }> {
  const rungs = raw.map((entry, i) => {
    const [m, f] = entry.split(':');
    const multiple = Number(m);
    const fraction = Number(f);
    if (!Number.isFinite(multiple) || multiple <= 1) {
      throw new Error(`TP_LADDER rung ${i}: multiple must be > 1, got "${entry}"`);
    }
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
      throw new Error(`TP_LADDER rung ${i}: fraction must be in (0,1], got "${entry}"`);
    }
    return { multiple, fraction };
  });
  rungs.sort((a, b) => a.multiple - b.multiple);
  const total = rungs.reduce((s, r) => s + r.fraction, 0);
  if (total > 1.0000001) {
    throw new Error(`TP_LADDER fractions sum to ${total.toFixed(3)}, must be <= 1`);
  }
  return rungs;
}

let cached: Config | null = null;

/**
 * Drops empty-string variables so they fall through to their defaults.
 *
 * A `.env` line written as `MODE=` yields `""`, not `undefined`. Without this
 * an empty enum crashes at startup, and — far worse — an empty numeric coerces
 * to `0`, which would silently turn `BUY_LAMPORTS=` into a zero-size trade.
 */
function presentEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && v.trim() !== '') out[k] = v;
  }
  return out;
}

export function getConfig(): Config {
  if (cached) return cached;
  const parsed = Schema.safeParse(presentEnv());
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const base = parsed.data;

  if (base.MODE === 'live' && !base.WALLET_SECRET) {
    throw new Error('MODE=live requires WALLET_SECRET');
  }
  if (base.RPC_HTTP.length === 0) {
    throw new Error('RPC_HTTP must list at least one endpoint');
  }
  if (base.BUY_LAMPORTS > base.MAX_EXPOSURE_LAMPORTS) {
    throw new Error('BUY_LAMPORTS exceeds MAX_EXPOSURE_LAMPORTS: no trade could ever open');
  }

  cached = { ...base, tpLadder: parseLadder(base.TP_LADDER) };
  return cached;
}

/** Test hook: drop the memoised config so env changes take effect. */
export function resetConfig(): void {
  cached = null;
}
