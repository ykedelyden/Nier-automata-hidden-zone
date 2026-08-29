import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
  type TransactionInstruction,
} from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { PROGRAMS, ata, bondingCurvePda } from '../chain/programs.js';
import type { BlockhashCache } from '../chain/blockhash.js';
import type { FeeOracle } from '../chain/fees.js';
import { tipIx } from '../chain/jito.js';
import type { RpcPool } from '../chain/rpcPool.js';
import type { Sender } from '../chain/sender.js';
import type { Config } from '../config.js';
import { makeLogger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import { sol } from '../core/util.js';
import type { EntryResult, Executor, LaunchEvent, Position, Reserves, SendOutcome } from '../types.js';
import { grossUpBuy, solForTokens, spotPrice, tokensForSol } from './pumpfun/curve.js';
import { buyIx, sellIx, type PumpLayoutVersion } from './pumpfun/ix.js';
import { decodeBondingCurve, decodeTokenAmount } from './pumpfun/layout.js';

const log = makeLogger('exec:pump');

const BPS = 10_000n;

export interface ExecutorDeps {
  readonly pool: RpcPool;
  readonly sender: Sender;
  readonly blockhash: BlockhashCache;
  readonly fees: FeeOracle;
  readonly cfg: Config;
  readonly layout: PumpLayoutVersion;
}

/**
 * Native pump.fun bonding-curve executor.
 *
 * Entries are built entirely from cached state — blockhash, fee estimate,
 * locally derived PDAs — so the only unavoidable network step is the broadcast
 * itself. The ATA is created with the idempotent instruction rather than a
 * pre-check, which removes a round trip and is safe if a previous attempt
 * already created it.
 */
export class PumpFunExecutor implements Executor {
  readonly venue = 'pumpfun' as const;

  constructor(
    private readonly d: ExecutorDeps,
    private readonly signer: Keypair,
  ) {}

  async buy(ev: LaunchEvent, lamports: bigint, owner: PublicKey): Promise<EntryResult> {
    const mint = new PublicKey(ev.mint);
    const creator = ev.creator ? new PublicKey(ev.creator) : null;

    // Reserves come from the hot filter when it ran; otherwise pay for a read.
    const reserves = ev.reserves ?? (await this.readReserves(mint));
    if (reserves.complete) throw new Error('curve already complete');

    const slippage = BigInt(this.d.cfg.BUY_SLIPPAGE_BPS);
    // `lamports` is the budget the risk engine approved, fee included, so the
    // amount that actually reaches the curve is the budget net of the fee.
    const intoCurve = (lamports * BPS) / (BPS + 100n);
    const expectedTokens = tokensForSol(reserves, intoCurve);
    if (expectedTokens <= 0n) throw new Error('curve quote returned zero tokens');

    // Ask for fewer tokens than the quote so ordinary front-running inside the
    // same block does not revert the fill; `maxSolCost` is the real protection.
    const minTokens = (expectedTokens * (BPS - slippage)) / BPS;
    const maxSolCost = grossUpBuy((intoCurve * (BPS + slippage)) / BPS);

    const ixs: TransactionInstruction[] = [
      ...this.d.fees.budgetIxs(this.d.cfg.CU_LIMIT_BUY, 0),
      createAssociatedTokenAccountIdempotentInstruction(owner, ata(owner, mint), owner, mint),
      buyIx({
        mint,
        user: owner,
        creator,
        amount: minTokens,
        maxSolCost,
        layout: this.d.layout,
      }),
    ];
    if (this.d.cfg.JITO_ENABLED) {
      ixs.push(tipIx(owner, this.d.cfg.JITO_TIP_LAMPORTS));
    }

    const tx = this.compile(ixs, this.d.blockhash.get().blockhash);
    const send = await this.d.sender.send(tx, {
      label: 'buy',
      useJito: this.d.cfg.JITO_ENABLED,
      deadlineMs: 15_000,
    });

    const decimals = await this.decimalsFor(mint);
    const tokensRaw = await this.balanceOf(owner, mint);
    if (tokensRaw <= 0n) {
      throw new Error('entry confirmed but the token account is empty');
    }

    const entryPrice = (Number(lamports) / Number(tokensRaw)) * 10 ** decimals;
    metrics.inc('exec.buy.ok');
    log.info('entry filled', {
      mint: ev.mint,
      spent: sol(lamports),
      tokens: tokensRaw,
      price: entryPrice,
      ms: send.landedMs,
    });

    return { send, tokensRaw, costLamports: lamports, tokenDecimals: decimals, entryPrice };
  }

  /**
   * Exits escalate. Urgency 0 respects normal slippage; from urgency 3 the
   * minimum output drops to zero, because at that point the only thing that
   * matters is that the sell lands at all.
   */
  async sell(pos: Position, tokensRaw: bigint, owner: PublicKey, urgency: number): Promise<SendOutcome> {
    const mint = new PublicKey(pos.mint);
    const creator = pos.creator ? new PublicKey(pos.creator) : null;

    let minSolOutput = 0n;
    if (urgency < 3) {
      try {
        const reserves = await this.readReserves(mint);
        const expected = solForTokens(reserves, tokensRaw);
        const slippage = BigInt(this.d.cfg.BUY_SLIPPAGE_BPS + urgency * 500);
        minSolOutput = (expected * (BPS - (slippage > BPS ? BPS : slippage))) / BPS;
      } catch (err) {
        log.debug('exit quote failed; selling at market', { mint: pos.mint, err });
      }
    }

    const ixs: TransactionInstruction[] = [
      ...this.d.fees.budgetIxs(this.d.cfg.CU_LIMIT_SELL, urgency),
      sellIx({ mint, user: owner, creator, amount: tokensRaw, minSolOutput, layout: this.d.layout }),
    ];
    if (this.d.cfg.JITO_ENABLED && urgency >= 1) {
      ixs.push(tipIx(owner, this.d.cfg.JITO_TIP_LAMPORTS * (1 + urgency)));
    }

    const bh = await this.d.blockhash.getFresh();
    const tx = this.compile(ixs, bh.blockhash);
    const out = await this.d.sender.send(tx, {
      label: 'sell',
      useJito: this.d.cfg.JITO_ENABLED && urgency >= 1,
      deadlineMs: 20_000,
    });
    metrics.inc('exec.sell.ok');
    return out;
  }

  async price(pos: Position): Promise<number> {
    const reserves = await this.readReserves(new PublicKey(pos.mint));
    return spotPrice(reserves, pos.tokenDecimals);
  }

  /** Current wallet balance of `mint`, in raw base units. */
  async balanceOf(owner: PublicKey, mint: PublicKey): Promise<bigint> {
    const account = ata(owner, mint);
    const info = await this.d.pool.call(
      'getAccountInfo',
      (c) => c.getAccountInfo(account, { commitment: 'confirmed' }),
      4_000,
    );
    if (!info) return 0n;
    return decodeTokenAmount(info.data);
  }

  private async readReserves(mint: PublicKey): Promise<Reserves> {
    const info = await this.d.pool.race(
      'getAccountInfo',
      (c) => c.getAccountInfo(bondingCurvePda(mint), { commitment: 'processed' }),
      2_500,
    );
    if (!info) throw new Error(`bonding curve for ${mint.toBase58()} not found`);
    const s = decodeBondingCurve(info.data);
    return {
      virtualSol: s.virtualSol,
      virtualToken: s.virtualToken,
      realSol: s.realSol,
      realToken: s.realToken,
      tokenTotalSupply: s.tokenTotalSupply,
      complete: s.complete,
    };
  }

  private async decimalsFor(mint: PublicKey): Promise<number> {
    try {
      const res = await this.d.pool.call(
        'getTokenSupply',
        (c) => c.getTokenSupply(mint, 'confirmed'),
        3_000,
      );
      return res.value.decimals;
    } catch {
      return 6; // pump.fun mints are 6-decimal; a wrong guess only skews display
    }
  }

  private compile(ixs: TransactionInstruction[], blockhash: string): VersionedTransaction {
    const message = new TransactionMessage({
      payerKey: this.signer.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([this.signer]);
    return tx;
  }
}

export { PROGRAMS };
