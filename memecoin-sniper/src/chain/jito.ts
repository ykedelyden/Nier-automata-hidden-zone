import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import { makeLogger } from '../core/logger.js';

const log = makeLogger('jito');

/**
 * Canonical Jito tip accounts. A tip transfer must target one of these or the
 * bundle is dropped; picking at random spreads load and avoids write-lock
 * contention on a single account.
 */
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
].map((k) => new PublicKey(k));

export function randomTipAccount(): PublicKey {
  return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!;
}

/**
 * The tip must be a real SOL transfer inside the bundle. Putting it in the same
 * transaction as the swap is deliberate: if the swap reverts, the tip is not
 * paid either.
 */
export function tipIx(from: PublicKey, lamports: number): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: from,
    toPubkey: randomTipAccount(),
    lamports,
  });
}

export class JitoClient {
  constructor(private readonly endpoints: readonly string[]) {}

  get enabled(): boolean {
    return this.endpoints.length > 0;
  }

  /**
   * Submits a bundle to one block-engine region. Returns the bundle id.
   * Note: a bundle id is not a signature — landing must still be confirmed by
   * polling the transaction signatures on a normal RPC.
   */
  async sendBundle(endpoint: string, base64Txs: string[]): Promise<string> {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [base64Txs, { encoding: 'base64' }],
      }),
    });
    if (!res.ok) {
      throw new Error(`jito ${endpoint} HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (body.error) throw new Error(`jito ${endpoint}: ${body.error.message ?? 'unknown error'}`);
    if (!body.result) throw new Error(`jito ${endpoint}: empty result`);
    return body.result;
  }

  /** Fan out to every configured region; the first acceptance wins. */
  async broadcast(base64Txs: string[]): Promise<{ endpoint: string; bundleId: string }> {
    if (!this.enabled) throw new Error('jito disabled');
    const attempts = this.endpoints.map((endpoint) =>
      this.sendBundle(endpoint, base64Txs).then((bundleId) => ({ endpoint, bundleId })),
    );
    try {
      return await Promise.any(attempts);
    } catch (err) {
      log.warn('all jito regions rejected the bundle', { regions: this.endpoints.length });
      throw err;
    }
  }
}
