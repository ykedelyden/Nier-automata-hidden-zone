import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Accepts either a base58 secret key or a path to a JSON keypair file (the
 * format `solana-keygen` writes). Anything else is rejected loudly — a
 * malformed key must never be allowed to silently degrade into a new wallet.
 */
export function loadKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  if (trimmed === '') throw new Error('WALLET_SECRET is empty');

  if (trimmed.startsWith('[') || trimmed.endsWith('.json')) {
    const raw = trimmed.startsWith('[') ? trimmed : readFileSync(trimmed, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('WALLET_SECRET looks like a JSON keypair but did not parse');
    }
    if (!Array.isArray(parsed) || parsed.some((n) => typeof n !== 'number')) {
      throw new Error('JSON keypair must be an array of numbers');
    }
    const bytes = Uint8Array.from(parsed as number[]);
    if (bytes.length !== 64) throw new Error(`JSON keypair must be 64 bytes, got ${bytes.length}`);
    return Keypair.fromSecretKey(bytes);
  }

  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(trimmed);
  } catch {
    throw new Error('WALLET_SECRET is neither a base58 key nor a JSON keypair path');
  }
  if (decoded.length !== 64) {
    throw new Error(`base58 secret key must decode to 64 bytes, got ${decoded.length}`);
  }
  return Keypair.fromSecretKey(decoded);
}

/** A throwaway keypair so paper mode can build real transactions without a real key. */
export function paperKeypair(): Keypair {
  return Keypair.generate();
}
