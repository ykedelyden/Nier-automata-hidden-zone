import { PublicKey } from '@solana/web3.js';
import { PROGRAMS, PUMP_IX, anchorDiscriminator, bondingCurvePda } from '../../chain/programs.js';
import type { RpcPool } from '../../chain/rpcPool.js';
import { makeLogger } from '../../core/logger.js';
import { BONDING_CURVE_SIZE } from './layout.js';
import type { PumpLayoutVersion } from './ix.js';

const log = makeLogger('probe');

export interface ProbeReport {
  readonly layout: PumpLayoutVersion;
  readonly curveAccountSize: number;
  readonly discriminatorsMatch: boolean;
  readonly sampleMint: string;
}

/**
 * Determines which pump.fun account layout the live program is using.
 *
 * The bonding curve account grew by 32 bytes when the creator-fee vault was
 * introduced, so its size is an unambiguous fingerprint. Probing beats trusting
 * a constant: a bot on the wrong layout builds transactions that revert on
 * every launch, and the failure mode looks like bad luck rather than a bug.
 */
export async function probePumpLayout(pool: RpcPool, sampleMint: PublicKey): Promise<ProbeReport> {
  const curve = bondingCurvePda(sampleMint);
  const info = await pool.call(
    'getAccountInfo',
    (c) => c.getAccountInfo(curve, { commitment: 'confirmed' }),
    6_000,
  );
  if (!info) throw new Error(`no bonding curve at ${curve.toBase58()} for sample mint`);

  const size = info.data.length;
  const layout: PumpLayoutVersion = size >= BONDING_CURVE_SIZE ? 'creator-vault' : 'v1';

  const discriminatorsMatch =
    anchorDiscriminator('global', 'buy').equals(Buffer.from(PUMP_IX.buy)) &&
    anchorDiscriminator('global', 'sell').equals(Buffer.from(PUMP_IX.sell)) &&
    anchorDiscriminator('global', 'create').equals(Buffer.from(PUMP_IX.create));

  log.info('layout probed', { layout, size, discriminatorsMatch });
  return { layout, curveAccountSize: size, discriminatorsMatch, sampleMint: sampleMint.toBase58() };
}

/** Confirms the pump.fun program is deployed and executable at the expected address. */
export async function verifyProgram(pool: RpcPool): Promise<{ executable: boolean; owner: string }> {
  const info = await pool.call(
    'getAccountInfo',
    (c) => c.getAccountInfo(PROGRAMS.pumpFun, { commitment: 'confirmed' }),
    6_000,
  );
  if (!info) throw new Error('pump.fun program account not found — wrong cluster?');
  return { executable: info.executable, owner: info.owner.toBase58() };
}
