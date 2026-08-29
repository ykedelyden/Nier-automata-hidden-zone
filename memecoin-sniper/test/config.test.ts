import { strict as assert } from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import { getConfig, resetConfig } from '../src/config.js';
import { loadKeypair } from '../src/chain/wallet.js';
import { firstToLand, percentile, sol } from '../src/core/util.js';

const SAVED = { ...process.env };

afterEach(() => {
  process.env = { ...SAVED };
  resetConfig();
});

function withEnv(env: Record<string, string>): ReturnType<typeof getConfig> {
  process.env = { ...SAVED, ...env };
  resetConfig();
  return getConfig();
}

describe('configuration', () => {
  test('defaults to paper mode so a misconfigured run cannot spend real funds', () => {
    const cfg = withEnv({ MODE: '', RPC_HTTP: 'https://example.invalid' });
    assert.equal(cfg.MODE, 'paper');
  });

  test('live mode without a wallet is rejected', () => {
    assert.throws(
      () => withEnv({ MODE: 'live', WALLET_SECRET: '', RPC_HTTP: 'https://example.invalid' }),
      /requires WALLET_SECRET/,
    );
  });

  test('parses and sorts the take-profit ladder', () => {
    const cfg = withEnv({ TP_LADDER: '5:0.2,1.6:0.35,2.5:0.3', RPC_HTTP: 'https://example.invalid' });
    assert.deepEqual(
      cfg.tpLadder.map((r) => r.multiple),
      [1.6, 2.5, 5],
    );
  });

  test('rejects a ladder that would sell more than the whole bag', () => {
    assert.throws(
      () => withEnv({ TP_LADDER: '2:0.7,3:0.7', RPC_HTTP: 'https://example.invalid' }),
      /must be <= 1/,
    );
  });

  test('rejects a rung that is not actually a profit', () => {
    assert.throws(
      () => withEnv({ TP_LADDER: '0.9:0.5', RPC_HTTP: 'https://example.invalid' }),
      /multiple must be > 1/,
    );
  });

  test('rejects a buy size that could never clear the exposure cap', () => {
    assert.throws(
      () =>
        withEnv({
          RPC_HTTP: 'https://example.invalid',
          BUY_LAMPORTS: '200000000',
          MAX_EXPOSURE_LAMPORTS: '100000000',
        }),
      /exceeds MAX_EXPOSURE/,
    );
  });

  test('an empty numeric variable falls back instead of coercing to zero', () => {
    // `BUY_LAMPORTS=` in a .env file must not mean "trade nothing".
    const cfg = withEnv({ RPC_HTTP: 'https://example.invalid', BUY_LAMPORTS: '' });
    assert.equal(cfg.BUY_LAMPORTS, 20_000_000);
  });

  test('an empty boolean variable falls back to its default', () => {
    const cfg = withEnv({ RPC_HTTP: 'https://example.invalid', WATCH_PUMPFUN: '' });
    assert.equal(cfg.WATCH_PUMPFUN, true);
  });

  test('splits comma-separated endpoint lists', () => {
    const cfg = withEnv({ RPC_HTTP: 'https://a.invalid, https://b.invalid ,' });
    assert.deepEqual(cfg.RPC_HTTP, ['https://a.invalid', 'https://b.invalid']);
  });
});

describe('wallet loading', () => {
  test('rejects a base58 key of the wrong length', () => {
    assert.throws(() => loadKeypair('3Nxk9'), /64 bytes|neither/);
  });

  test('rejects an empty secret', () => {
    assert.throws(() => loadKeypair('   '), /empty/);
  });

  test('rejects a JSON array of the wrong length', () => {
    assert.throws(() => loadKeypair('[1,2,3]'), /64 bytes/);
  });
});

describe('utilities', () => {
  test('formats lamports as SOL with four decimals', () => {
    assert.equal(sol(1_500_000_000n), '1.5000');
    assert.equal(sol(0n), '0.0000');
    assert.equal(sol(-20_000_000n), '-0.0200');
  });

  test('percentile handles the empty and single-value cases', () => {
    assert.equal(percentile([], 50), 0);
    assert.equal(percentile([7], 99), 7);
    assert.equal(percentile([1, 2, 3, 4], 50), 2);
  });

  test('firstToLand returns the winner and its label', async () => {
    const result = await firstToLand([
      { label: 'slow', run: () => new Promise((r) => setTimeout(() => r('b'), 50)) },
      { label: 'fast', run: () => Promise.resolve('a') },
    ]);
    assert.equal(result.label, 'fast');
    assert.equal(result.value, 'a');
  });

  test('firstToLand tolerates a losing route failing', async () => {
    const result = await firstToLand([
      { label: 'broken', run: () => Promise.reject(new Error('down')) },
      { label: 'ok', run: () => new Promise((r) => setTimeout(() => r('v'), 10)) },
    ]);
    assert.equal(result.label, 'ok');
  });

  test('firstToLand rejects only once every route has failed', async () => {
    await assert.rejects(
      firstToLand([
        { label: 'a', run: () => Promise.reject(new Error('x')) },
        { label: 'b', run: () => Promise.reject(new Error('y')) },
      ]),
      /all routes failed/,
    );
  });
});
