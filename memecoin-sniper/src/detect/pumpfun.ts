import { PublicKey, type Connection, type Logs } from '@solana/web3.js';
import { PROGRAMS, anchorDiscriminator, bondingCurvePda } from '../chain/programs.js';
import type { RpcPool } from '../chain/rpcPool.js';
import { makeLogger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import type { LaunchEvent, TokenMetadata } from '../types.js';
import { BorshReader } from './borsh.js';

const log = makeLogger('detect:pump');

const CREATE_EVENT_DISC = anchorDiscriminator('event', 'CreateEvent');

export interface PumpCreate {
  readonly mint: PublicKey;
  readonly bondingCurve: PublicKey;
  readonly user: PublicKey;
  readonly creator: PublicKey;
  readonly metadata: TokenMetadata;
}

/**
 * Decodes a pump.fun `CreateEvent` out of a `Program data:` log line.
 *
 * This is the whole latency trick for pump.fun: the create event carries the
 * mint, the bonding curve and the creator inline, so the bot never has to fetch
 * the transaction to know what to buy. Detection to signed transaction stays
 * under a millisecond of local work.
 */
export function decodeCreateEvent(payload: Buffer): PumpCreate | null {
  if (payload.length < 8 || !payload.subarray(0, 8).equals(CREATE_EVENT_DISC)) return null;
  try {
    const r = new BorshReader(payload.subarray(8));
    const name = r.string(200);
    const symbol = r.string(64);
    const uri = r.string(400);
    const mint = r.pubkey();
    const bondingCurve = r.pubkey();
    const user = r.pubkey();
    // Newer program revisions append `creator`; older ones stop at `user`.
    const creator = r.remaining >= 32 ? r.pubkey() : user;
    return { mint, bondingCurve, user, creator, metadata: { name, symbol, uri } };
  } catch (err) {
    log.debug('create event did not decode', { err });
    return null;
  }
}

/** Pulls every base64 `Program data:` payload out of a log array. */
export function programDataPayloads(logs: readonly string[]): Buffer[] {
  const out: Buffer[] = [];
  for (const line of logs) {
    const idx = line.indexOf('Program data: ');
    if (idx === -1) continue;
    const b64 = line.slice(idx + 'Program data: '.length).trim();
    try {
      out.push(Buffer.from(b64, 'base64'));
    } catch {
      /* a malformed line is not worth aborting the batch for */
    }
  }
  return out;
}

export type LaunchSink = (ev: Omit<LaunchEvent, 'seq'>) => void;

/**
 * Subscribes to pump.fun logs on *every* RPC in the pool simultaneously.
 *
 * Providers see new transactions at genuinely different times — tens to
 * hundreds of milliseconds apart. Running all subscriptions and letting the
 * dispatcher deduplicate means the bot always reacts at the speed of its
 * fastest provider, not its average one.
 */
export class PumpFunDetector {
  private subs: Array<{ conn: Connection; id: number }> = [];
  private running = false;

  constructor(
    private readonly pool: RpcPool,
    private readonly sink: LaunchSink,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    for (const { label, conn } of this.pool.connections()) {
      try {
        const id = conn.onLogs(
          PROGRAMS.pumpFun,
          (logs, ctx) => this.onLogs(label, logs, ctx.slot),
          'processed',
        );
        this.subs.push({ conn, id });
        log.info('subscribed', { node: label });
      } catch (err) {
        log.warn('subscribe failed', { node: label, err });
      }
    }
    if (this.subs.length === 0) throw new Error('pump.fun detector could not subscribe anywhere');
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.subs.map(({ conn, id }) => conn.removeOnLogsListener(id)));
    this.subs = [];
  }

  private onLogs(node: string, logs: Logs, slot: number): void {
    if (logs.err) return; // a reverted create is not a launch
    const seenAt = performance.now();
    for (const payload of programDataPayloads(logs.logs)) {
      const create = decodeCreateEvent(payload);
      if (!create) continue;
      metrics.inc('detect.pumpfun.create');
      this.sink({
        venue: 'pumpfun',
        mint: create.mint.toBase58(),
        creator: create.creator.toBase58(),
        signature: logs.signature,
        slot,
        accounts: {
          bondingCurve: create.bondingCurve.toBase58(),
          // Recomputed locally as a sanity check on the event payload.
          derivedCurve: bondingCurvePda(create.mint).toBase58(),
          user: create.user.toBase58(),
        },
        reserves: null,
        seenAt,
        detector: `pumpfun@${node}`,
        metadata: create.metadata,
      });
    }
  }
}
