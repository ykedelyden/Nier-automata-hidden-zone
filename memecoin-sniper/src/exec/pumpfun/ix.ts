import {
  PublicKey,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import {
  PROGRAMS,
  PUMP_IX,
  ata,
  bondingCurvePda,
  creatorVaultPda,
} from '../../chain/programs.js';

/**
 * pump.fun changed the buy/sell account list when it introduced creator fee
 * vaults. Both orderings are kept because a bot that guesses wrong builds
 * transactions that revert with `AccountNotEnoughKeys` on every single snipe.
 *
 * `doctor` probes the live program and reports which layout is in force.
 */
export type PumpLayoutVersion = 'v1' | 'creator-vault';

export interface BuyParams {
  readonly mint: PublicKey;
  readonly user: PublicKey;
  readonly creator: PublicKey | null;
  /** Token base units to receive. */
  readonly amount: bigint;
  /** Hard ceiling on lamports spent, including the protocol fee. */
  readonly maxSolCost: bigint;
  readonly layout: PumpLayoutVersion;
  readonly feeRecipient?: PublicKey;
}

export interface SellParams {
  readonly mint: PublicKey;
  readonly user: PublicKey;
  readonly creator: PublicKey | null;
  readonly amount: bigint;
  readonly minSolOutput: bigint;
  readonly layout: PumpLayoutVersion;
  readonly feeRecipient?: PublicKey;
}

function meta(pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta {
  return { pubkey, isSigner, isWritable };
}

function argsBuffer(discriminator: Buffer, a: bigint, b: bigint): Buffer {
  const buf = Buffer.alloc(24);
  discriminator.copy(buf, 0);
  buf.writeBigUInt64LE(a, 8);
  buf.writeBigUInt64LE(b, 16);
  return buf;
}

function resolveCreatorVault(mint: PublicKey, creator: PublicKey | null): PublicKey {
  // With no known creator the vault cannot be derived; the program rejects the
  // transaction rather than silently paying the wrong account.
  if (!creator) throw new Error(`creator unknown for ${mint.toBase58()}: cannot derive creator vault`);
  return creatorVaultPda(creator);
}

export function buyIx(p: BuyParams): TransactionInstruction {
  const curve = bondingCurvePda(p.mint);
  const curveAta = ata(curve, p.mint, true);
  const userAta = ata(p.user, p.mint);
  const feeRecipient = p.feeRecipient ?? PROGRAMS.pumpFunFeeRecipient;

  const keys: AccountMeta[] =
    p.layout === 'creator-vault'
      ? [
          meta(PROGRAMS.pumpFunGlobal, false, false),
          meta(feeRecipient, false, true),
          meta(p.mint, false, false),
          meta(curve, false, true),
          meta(curveAta, false, true),
          meta(userAta, false, true),
          meta(p.user, true, true),
          meta(PROGRAMS.systemProgram, false, false),
          meta(PROGRAMS.tokenProgram, false, false),
          meta(resolveCreatorVault(p.mint, p.creator), false, true),
          meta(PROGRAMS.pumpFunEventAuthority, false, false),
          meta(PROGRAMS.pumpFun, false, false),
        ]
      : [
          meta(PROGRAMS.pumpFunGlobal, false, false),
          meta(feeRecipient, false, true),
          meta(p.mint, false, false),
          meta(curve, false, true),
          meta(curveAta, false, true),
          meta(userAta, false, true),
          meta(p.user, true, true),
          meta(PROGRAMS.systemProgram, false, false),
          meta(PROGRAMS.tokenProgram, false, false),
          meta(PROGRAMS.rent, false, false),
          meta(PROGRAMS.pumpFunEventAuthority, false, false),
          meta(PROGRAMS.pumpFun, false, false),
        ];

  return new TransactionInstruction({
    programId: PROGRAMS.pumpFun,
    keys,
    data: argsBuffer(Buffer.from(PUMP_IX.buy), p.amount, p.maxSolCost),
  });
}

export function sellIx(p: SellParams): TransactionInstruction {
  const curve = bondingCurvePda(p.mint);
  const curveAta = ata(curve, p.mint, true);
  const userAta = ata(p.user, p.mint);
  const feeRecipient = p.feeRecipient ?? PROGRAMS.pumpFunFeeRecipient;

  const keys: AccountMeta[] =
    p.layout === 'creator-vault'
      ? [
          meta(PROGRAMS.pumpFunGlobal, false, false),
          meta(feeRecipient, false, true),
          meta(p.mint, false, false),
          meta(curve, false, true),
          meta(curveAta, false, true),
          meta(userAta, false, true),
          meta(p.user, true, true),
          meta(PROGRAMS.systemProgram, false, false),
          meta(resolveCreatorVault(p.mint, p.creator), false, true),
          meta(PROGRAMS.tokenProgram, false, false),
          meta(PROGRAMS.pumpFunEventAuthority, false, false),
          meta(PROGRAMS.pumpFun, false, false),
        ]
      : [
          meta(PROGRAMS.pumpFunGlobal, false, false),
          meta(feeRecipient, false, true),
          meta(p.mint, false, false),
          meta(curve, false, true),
          meta(curveAta, false, true),
          meta(userAta, false, true),
          meta(p.user, true, true),
          meta(PROGRAMS.systemProgram, false, false),
          meta(PROGRAMS.associatedToken, false, false),
          meta(PROGRAMS.tokenProgram, false, false),
          meta(PROGRAMS.pumpFunEventAuthority, false, false),
          meta(PROGRAMS.pumpFun, false, false),
        ];

  return new TransactionInstruction({
    programId: PROGRAMS.pumpFun,
    keys,
    data: argsBuffer(Buffer.from(PUMP_IX.sell), p.amount, p.minSolOutput),
  });
}
