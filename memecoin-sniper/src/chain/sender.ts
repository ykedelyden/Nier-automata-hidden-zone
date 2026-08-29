import {
  VersionedTransaction,
  type Connection,
  type SignatureStatus,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { makeLogger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import { sleep } from '../core/util.js';
import type { SendOutcome } from '../types.js';
import type { JitoClient } from './jito.js';
import type { RpcPool } from './rpcPool.js';

const log = makeLogger('sender');

export interface SendOptions {
  /** Stop re-broadcasting and give up after this long. */
  readonly deadlineMs: number;
  /** How often to re-broadcast the same signed transaction. */
  readonly rebroadcastMs: number;
  readonly useJito: boolean;
  readonly label: string;
}

const DEFAULTS: Omit<SendOptions, 'label'> = {
  deadlineMs: 20_000,
  rebroadcastMs: 400,
  useJito: false,
};

/**
 * Broadcasts a signed transaction as aggressively as is safe.
 *
 * The strategy: submit to every send endpoint at once with `skipPreflight`,
 * keep re-submitting the *same* signed bytes on a short timer, and poll for
 * confirmation in parallel. Re-broadcasting identical bytes is safe — the
 * signature dedupes at the leader, so a landed transaction can never execute
 * twice — and it is the only reliable way to survive a dropped packet during a
 * congestion spike.
 */
export class Sender {
  constructor(
    private readonly pool: RpcPool,
    private readonly sendPool: RpcPool,
    private readonly jito: JitoClient,
  ) {}

  async send(tx: VersionedTransaction, opts: Partial<SendOptions> & { label: string }): Promise<SendOutcome> {
    const o: SendOptions = { ...DEFAULTS, ...opts };
    const raw = Buffer.from(tx.serialize());
    const signature = bs58.encode(tx.signatures[0]!);
    const started = performance.now();

    let stopped = false;
    const routes = new Set<string>();

    const broadcastOnce = async (): Promise<void> => {
      const jobs: Array<Promise<unknown>> = [];
      for (const { label, conn } of this.sendPool.connections()) {
        jobs.push(
          this.rawSend(conn, raw)
            .then(() => routes.add(label))
            .catch((err) => log.trace('broadcast leg failed', { route: label, err })),
        );
      }
      if (o.useJito && this.jito.enabled) {
        jobs.push(
          this.jito
            .broadcast([raw.toString('base64')])
            .then((r) => routes.add(`jito:${new URL(r.endpoint).hostname.split('.')[1] ?? 'x'}`))
            .catch((err) => log.trace('jito leg failed', { err })),
        );
      }
      await Promise.allSettled(jobs);
    };

    const rebroadcastLoop = async (): Promise<void> => {
      while (!stopped && performance.now() - started < o.deadlineMs) {
        await broadcastOnce();
        metrics.inc(`send.broadcast.${o.label}`);
        await sleep(o.rebroadcastMs);
      }
    };

    const confirmLoop = async (): Promise<SendOutcome> => {
      // Give the first broadcast a beat before spending RPC budget on polling.
      await sleep(250);
      while (performance.now() - started < o.deadlineMs) {
        const status = await this.status(signature);
        if (status) {
          if (status.err) {
            throw new TransactionFailedError(signature, JSON.stringify(status.err));
          }
          if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized' || status.confirmations === null) {
            return {
              signature,
              route: [...routes].join('+') || 'unknown',
              landedMs: performance.now() - started,
              slot: status.slot ?? null,
            };
          }
        }
        await sleep(180);
      }
      throw new SendTimeoutError(signature, o.deadlineMs);
    };

    void rebroadcastLoop();
    try {
      const outcome = await confirmLoop();
      metrics.observe(`send.land.${o.label}`, outcome.landedMs);
      log.debug('landed', { label: o.label, sig: signature.slice(0, 12), ms: outcome.landedMs, route: outcome.route });
      return outcome;
    } finally {
      stopped = true;
    }
  }

  private async rawSend(conn: Connection, raw: Buffer): Promise<string> {
    return conn.sendRawTransaction(raw, {
      skipPreflight: true, // preflight costs a round trip we do not have
      maxRetries: 0, // we drive our own re-broadcast cadence
      preflightCommitment: 'processed',
    });
  }

  private async status(signature: string): Promise<SignatureStatus | null> {
    try {
      const res = await this.pool.race(
        'getSignatureStatuses',
        (c) => c.getSignatureStatuses([signature], { searchTransactionHistory: false }),
        2_000,
      );
      return res.value[0] ?? null;
    } catch {
      return null;
    }
  }
}

export class SendTimeoutError extends Error {
  override readonly name = 'SendTimeoutError';
  constructor(readonly signature: string, ms: number) {
    super(`transaction ${signature.slice(0, 12)} did not confirm within ${ms}ms`);
  }
}

export class TransactionFailedError extends Error {
  override readonly name = 'TransactionFailedError';
  constructor(readonly signature: string, readonly reason: string) {
    super(`transaction ${signature.slice(0, 12)} reverted: ${reason}`);
  }
}
