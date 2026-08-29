import { PublicKey, type Connection, type Logs } from '@solana/web3.js';
import { PROGRAMS } from '../chain/programs.js';
import type { RpcPool } from '../chain/rpcPool.js';
import { makeLogger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import type { LaunchSink } from './pumpfun.js';

const log = makeLogger('detect:ray');

/**
 * Account order of Raydium AMM v4 `initialize2`. Positions 8/9 are the token
 * pair and 4 is the AMM id, which is everything a swap needs to be routed.
 */
const INIT2_ACCOUNTS = {
  amm: 4,
  ammAuthority: 5,
  ammOpenOrders: 6,
  lpMint: 7,
  coinMint: 8,
  pcMint: 9,
  poolCoinVault: 10,
  poolPcVault: 11,
  ammTargetOrders: 13,
  serumMarket: 16,
  userWallet: 17,
} as const;

const QUOTE_MINTS = new Set([PROGRAMS.wsol.toBase58(), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v']);

/**
 * Watches for new Raydium AMM v4 pools.
 *
 * Unlike pump.fun, `initialize2` emits no decodable event, so the pool keys
 * have to come from the transaction itself. That costs one extra round trip —
 * acceptable here, because a migration to Raydium is not a sub-second race the
 * way a bonding-curve launch is.
 */
export class RaydiumDetector {
  private subs: Array<{ conn: Connection; id: number }> = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly pool: RpcPool,
    private readonly sink: LaunchSink,
  ) {}

  async start(): Promise<void> {
    for (const { label, conn } of this.pool.connections()) {
      try {
        const id = conn.onLogs(
          PROGRAMS.raydiumAmmV4,
          (logs, ctx) => void this.onLogs(label, logs, ctx.slot),
          'processed',
        );
        this.subs.push({ conn, id });
        log.info('subscribed', { node: label });
      } catch (err) {
        log.warn('subscribe failed', { node: label, err });
      }
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.subs.map(({ conn, id }) => conn.removeOnLogsListener(id)));
    this.subs = [];
  }

  private async onLogs(node: string, logs: Logs, slot: number): Promise<void> {
    if (logs.err) return;
    if (!logs.logs.some((l) => l.includes('initialize2'))) return;
    if (this.seen.has(logs.signature)) return;
    this.seen.add(logs.signature);
    if (this.seen.size > 5_000) this.seen.clear();

    const seenAt = performance.now();
    try {
      const keys = await this.poolKeys(logs.signature);
      if (!keys) return;
      metrics.inc('detect.raydium.init');
      this.sink({
        venue: 'raydium-amm4',
        mint: keys.tokenMint,
        creator: keys.userWallet,
        signature: logs.signature,
        slot,
        accounts: keys.accounts,
        reserves: null,
        seenAt,
        detector: `raydium@${node}`,
        metadata: null,
      });
    } catch (err) {
      log.debug('pool key extraction failed', { sig: logs.signature.slice(0, 12), err });
    }
  }

  private async poolKeys(signature: string): Promise<{
    tokenMint: string;
    userWallet: string;
    accounts: Record<string, string>;
  } | null> {
    const tx = await this.pool.call(
      'getTransaction',
      (c) =>
        c.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        }),
      5_000,
    );
    if (!tx) return null;

    const message = tx.transaction.message;
    const allKeys = message.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses,
    });

    for (const ix of message.compiledInstructions) {
      const programId = allKeys.get(ix.programIdIndex);
      if (!programId?.equals(PROGRAMS.raydiumAmmV4)) continue;
      if (ix.accountKeyIndexes.length <= INIT2_ACCOUNTS.userWallet) continue;

      const at = (pos: number): string => {
        const idx = ix.accountKeyIndexes[pos];
        const key = idx === undefined ? undefined : allKeys.get(idx);
        return key ? key.toBase58() : '';
      };

      const coinMint = at(INIT2_ACCOUNTS.coinMint);
      const pcMint = at(INIT2_ACCOUNTS.pcMint);
      // The interesting side is whichever mint is *not* the quote asset.
      const tokenMint = QUOTE_MINTS.has(coinMint) ? pcMint : coinMint;
      // A pool with two quote assets (or none) is not a memecoin launch.
      if (!tokenMint || QUOTE_MINTS.has(coinMint) === QUOTE_MINTS.has(pcMint)) return null;

      const accounts: Record<string, string> = {};
      for (const [name, pos] of Object.entries(INIT2_ACCOUNTS)) {
        accounts[name] = at(pos);
      }
      accounts['quoteMint'] = QUOTE_MINTS.has(coinMint) ? coinMint : pcMint;
      return { tokenMint, userWallet: at(INIT2_ACCOUNTS.userWallet), accounts };
    }
    return null;
  }
}

export function isQuoteMint(mint: string): boolean {
  return QUOTE_MINTS.has(mint);
}

export function raydiumPoolPubkey(accounts: Record<string, string>): PublicKey | null {
  const amm = accounts['amm'];
  return amm ? new PublicKey(amm) : null;
}
