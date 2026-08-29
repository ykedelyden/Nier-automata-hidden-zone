import { PublicKey } from '@solana/web3.js';
import type { Reserves } from '../../types.js';

/**
 * `BondingCurve` account layout.
 *
 * ```text
 * 0   [8]  anchor discriminator
 * 8   u64  virtual_token_reserves
 * 16  u64  virtual_sol_reserves
 * 24  u64  real_token_reserves
 * 32  u64  real_sol_reserves
 * 40  u64  token_total_supply
 * 48  u8   complete
 * 49  [32] creator            (added in the 2024 program revision)
 * ```
 */
export const BONDING_CURVE_LEGACY_SIZE = 49;
export const BONDING_CURVE_SIZE = 81;

export interface BondingCurveAccount extends Reserves {
  /** `null` on the legacy layout, which had no creator field. */
  readonly creator: PublicKey | null;
}

function u64(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

export function decodeBondingCurve(data: Buffer | Uint8Array): BondingCurveAccount {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < BONDING_CURVE_LEGACY_SIZE) {
    throw new Error(`bonding curve account too small: ${buf.length} bytes`);
  }
  const creator =
    buf.length >= BONDING_CURVE_SIZE ? new PublicKey(buf.subarray(49, 81)) : null;
  return {
    virtualToken: u64(buf, 8),
    virtualSol: u64(buf, 16),
    realToken: u64(buf, 24),
    realSol: u64(buf, 32),
    tokenTotalSupply: u64(buf, 40),
    complete: buf.readUInt8(48) !== 0,
    creator,
  };
}

/**
 * SPL `Mint` layout, decoded by hand rather than via `getMint` so the hot path
 * can reuse a single `getMultipleAccounts` response.
 *
 * ```text
 * 0   u32  COption tag for mint_authority
 * 4   [32] mint_authority
 * 36  u64  supply
 * 44  u8   decimals
 * 45  u8   is_initialized
 * 46  u32  COption tag for freeze_authority
 * 50  [32] freeze_authority
 * ```
 */
export interface MintInfo {
  readonly mintAuthority: PublicKey | null;
  readonly freezeAuthority: PublicKey | null;
  readonly supply: bigint;
  readonly decimals: number;
  readonly initialized: boolean;
}

export function decodeMint(data: Buffer | Uint8Array): MintInfo {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 82) throw new Error(`mint account too small: ${buf.length} bytes`);
  const hasMintAuth = buf.readUInt32LE(0) === 1;
  const hasFreezeAuth = buf.readUInt32LE(46) === 1;
  return {
    mintAuthority: hasMintAuth ? new PublicKey(buf.subarray(4, 36)) : null,
    supply: buf.readBigUInt64LE(36),
    decimals: buf.readUInt8(44),
    initialized: buf.readUInt8(45) !== 0,
    freezeAuthority: hasFreezeAuth ? new PublicKey(buf.subarray(50, 82)) : null,
  };
}

/** SPL token account: amount lives at offset 64, owner at 32. */
export function decodeTokenAmount(data: Buffer | Uint8Array): bigint {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 72) throw new Error(`token account too small: ${buf.length} bytes`);
  return buf.readBigUInt64LE(64);
}

export function decodeTokenOwner(data: Buffer | Uint8Array): PublicKey {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return new PublicKey(buf.subarray(32, 64));
}
