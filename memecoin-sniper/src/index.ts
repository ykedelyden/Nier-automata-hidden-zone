import { PublicKey } from '@solana/web3.js';
import { PROGRAMS, PUMP_IX, anchorDiscriminator } from './chain/programs.js';
import { RpcPool } from './chain/rpcPool.js';
import { loadKeypair } from './chain/wallet.js';
import { getConfig, type Config } from './config.js';
import { makeLogger, setLogLevel } from './core/logger.js';
import { sleep, sol } from './core/util.js';
import { PumpFunDetector } from './detect/pumpfun.js';
import { probePumpLayout, verifyProgram } from './exec/pumpfun/probe.js';
import { Runtime } from './runtime.js';
import type { LaunchEvent } from './types.js';

const log = makeLogger('cli');

const USAGE = `
memecoin-sniper

  run       Detect launches, filter them, and trade (paper unless MODE=live).
  watch     Detect and score launches, print what it *would* do. Never trades.
  doctor    Verify RPC endpoints, program layout, wallet and fee conditions.

Configuration is read from .env — see .env.example.
`;

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'run';
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  const cfg = getConfig();
  setLogLevel(cfg.LOG_LEVEL);

  switch (command) {
    case 'run':
      await runCommand(cfg, false);
      break;
    case 'watch':
      await runCommand(cfg, true);
      break;
    case 'doctor':
      await doctorCommand(cfg);
      break;
    default:
      process.stderr.write(`unknown command: ${command}\n${USAGE}`);
      process.exitCode = 2;
  }
}

async function runCommand(cfg: Config, observeOnly: boolean): Promise<void> {
  if (cfg.MODE === 'live' && !observeOnly) {
    log.warn('LIVE MODE — real funds are at risk');
    log.warn('starting in 5s; Ctrl+C now to abort');
    await sleep(5_000);
  }

  const runtime = new Runtime(cfg, { observeOnly });
  await runtime.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      log.error('second signal — exiting immediately');
      process.exit(1);
    }
    shuttingDown = true;
    await runtime.stop(signal);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err }));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception — shutting down', { err });
    void shutdown('uncaughtException');
  });

  // Hold the process open; all work is event-driven from here.
  await new Promise<never>(() => {});
}

/**
 * Pre-flight check. Everything it verifies is something that, if wrong, makes
 * the bot lose money silently rather than fail loudly.
 */
async function doctorCommand(cfg: Config): Promise<void> {
  const results: Array<[string, boolean, string]> = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    results.push([name, ok, detail]);
  };

  const pool = new RpcPool(cfg.RPC_HTTP, cfg.RPC_WS);

  // 1. RPC reachability and latency spread.
  for (const { label, conn } of pool.connections()) {
    const t0 = performance.now();
    try {
      const slot = await conn.getSlot('processed');
      const ms = performance.now() - t0;
      check(`rpc ${label}`, ms < 500, `slot ${slot} in ${ms.toFixed(0)}ms`);
    } catch (err) {
      check(`rpc ${label}`, false, err instanceof Error ? err.message : String(err));
    }
  }

  // 2. Anchor discriminators still match the committed constants.
  const discOk =
    anchorDiscriminator('global', 'buy').equals(Buffer.from(PUMP_IX.buy)) &&
    anchorDiscriminator('global', 'sell').equals(Buffer.from(PUMP_IX.sell));
  check('instruction discriminators', discOk, discOk ? 'buy/sell match' : 'MISMATCH — do not trade');

  // 3. The program is deployed where we think it is.
  try {
    const program = await verifyProgram(pool);
    check('pump.fun program', program.executable, `owner ${program.owner}`);
  } catch (err) {
    check('pump.fun program', false, err instanceof Error ? err.message : String(err));
  }

  // 4. Wallet.
  if (cfg.WALLET_SECRET) {
    try {
      const kp = loadKeypair(cfg.WALLET_SECRET);
      const lamports = await pool.call('getBalance', (c) => c.getBalance(kp.publicKey, 'confirmed'));
      const enough = BigInt(lamports) > BigInt(cfg.MIN_WALLET_RESERVE_LAMPORTS) + BigInt(cfg.BUY_LAMPORTS);
      check(
        'wallet',
        enough,
        `${kp.publicKey.toBase58()} holds ${sol(BigInt(lamports))} SOL` +
          (enough ? '' : ' — below reserve + one clip'),
      );
    } catch (err) {
      check('wallet', false, err instanceof Error ? err.message : String(err));
    }
  } else {
    check('wallet', cfg.MODE === 'paper', 'no WALLET_SECRET (fine for paper mode)');
  }

  // 5. Live account layout, learned from a real launch.
  log.info('waiting up to 60s for a live launch to probe the account layout...');
  try {
    const mint = await firstLaunchMint(pool, 60_000);
    // The curve account may not be readable in the same instant it is created.
    await sleep(1_200);
    const report = await probePumpLayout(pool, new PublicKey(mint));
    check(
      'account layout',
      report.discriminatorsMatch,
      `${report.layout} (curve account ${report.curveAccountSize} bytes) from ${mint.slice(0, 8)}`,
    );
  } catch (err) {
    check('account layout', false, err instanceof Error ? err.message : String(err));
  }

  // 6. Priority fee conditions right now.
  try {
    const fees = await pool.call('getRecentPrioritizationFees', (c) =>
      c.getRecentPrioritizationFees({ lockedWritableAccounts: [PROGRAMS.pumpFun] }),
    );
    const nonZero = fees.map((f) => f.prioritizationFee).filter((v) => v > 0).sort((a, b) => a - b);
    const p75 = nonZero[Math.floor(nonZero.length * 0.75)] ?? 0;
    check(
      'priority fees',
      cfg.PRIORITY_FEE_MICROLAMPORTS >= p75,
      `network p75 ≈ ${p75} µlamports/CU, configured base ${cfg.PRIORITY_FEE_MICROLAMPORTS}`,
    );
  } catch (err) {
    check('priority fees', false, err instanceof Error ? err.message : String(err));
  }

  process.stdout.write('\n');
  for (const [name, ok, detail] of results) {
    process.stdout.write(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name.padEnd(28)} ${detail}\n`);
  }
  const failures = results.filter(([, ok]) => !ok).length;
  process.stdout.write(`\n  ${results.length - failures}/${results.length} checks passed\n\n`);
  process.exitCode = failures > 0 ? 1 : 0;
}

/** Resolves with the mint of the first pump.fun launch observed. */
function firstLaunchMint(pool: RpcPool, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const detector = new PumpFunDetector(pool, (ev: Omit<LaunchEvent, 'seq'>) => {
      if (settled) return;
      settled = true;
      void detector.stop();
      clearTimeout(timer);
      resolve(ev.mint);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void detector.stop();
      reject(new Error(`no launch observed within ${timeoutMs}ms`));
    }, timeoutMs);
    detector.start().catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

main().catch((err) => {
  log.error('fatal', { err });
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
