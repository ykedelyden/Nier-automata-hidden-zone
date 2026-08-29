import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

/** Well-known mainnet program and account addresses used across the bot. */
export const PROGRAMS = {
  pumpFun: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
  pumpFunGlobal: new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf'),
  pumpFunEventAuthority: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'),
  pumpFunFeeRecipient: new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM'),
  raydiumAmmV4: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
  raydiumCpmm: new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),
  tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  token2022: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
  associatedToken: new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
  systemProgram: new PublicKey('11111111111111111111111111111111'),
  rent: new PublicKey('SysvarRent111111111111111111111111111111111'),
  wsol: new PublicKey('So11111111111111111111111111111111111111112'),
  metaplexMetadata: new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),
} as const;

/**
 * Anchor 8-byte instruction discriminators, `sha256("global:<name>")[0..8]`.
 *
 * These are stable for a deployed program but *not* for a redeployed one.
 * `npm run doctor` verifies them against a live account fetch before you trade.
 */
export const PUMP_IX = {
  create: Buffer.from('181ec828051c0777', 'hex'),
  buy: Buffer.from('66063d1201daebea', 'hex'),
  sell: Buffer.from('33e685a4017f83ad', 'hex'),
} as const;

export function bondingCurvePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PROGRAMS.pumpFun,
  )[0];
}

/**
 * Vault that receives the creator's share of trade fees. Present in the
 * post-2024 pump.fun account layout; see `PUMP_ACCOUNT_LAYOUT` in ix.ts.
 */
export function creatorVaultPda(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PROGRAMS.pumpFun,
  )[0];
}

export function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), PROGRAMS.metaplexMetadata.toBuffer(), mint.toBuffer()],
    PROGRAMS.metaplexMetadata,
  )[0];
}

/** Associated token account, derived locally to avoid an RPC round trip. */
export function ata(owner: PublicKey, mint: PublicKey, allowOwnerOffCurve = false): PublicKey {
  if (!allowOwnerOffCurve && !PublicKey.isOnCurve(owner.toBuffer())) {
    throw new Error(`owner ${owner.toBase58()} is off-curve; pass allowOwnerOffCurve`);
  }
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), PROGRAMS.tokenProgram.toBuffer(), mint.toBuffer()],
    PROGRAMS.associatedToken,
  )[0];
}

/**
 * Anchor discriminator: the first 8 bytes of `sha256("<namespace>:<Name>")`.
 * Computing it at runtime beats hardcoding — it stays correct if a program is
 * redeployed with the same instruction names.
 */
export function anchorDiscriminator(namespace: 'global' | 'event', name: string): Buffer {
  return createHash('sha256').update(`${namespace}:${name}`).digest().subarray(0, 8);
}
