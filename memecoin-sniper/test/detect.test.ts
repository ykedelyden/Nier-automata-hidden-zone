import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { PUMP_IX, anchorDiscriminator, ata, bondingCurvePda } from '../src/chain/programs.js';
import { Dispatcher } from '../src/detect/dispatcher.js';
import { decodeCreateEvent, programDataPayloads } from '../src/detect/pumpfun.js';
import { decodeBondingCurve, decodeMint, decodeTokenAmount } from '../src/exec/pumpfun/layout.js';
import type { LaunchEvent } from '../src/types.js';

function borshString(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
}

function createEventPayload(opts: { withCreator: boolean }): {
  payload: Buffer;
  mint: PublicKey;
  creator: PublicKey;
  user: PublicKey;
} {
  const mint = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  const parts = [
    anchorDiscriminator('event', 'CreateEvent'),
    borshString('Test Coin'),
    borshString('TEST'),
    borshString('https://example.com/meta.json'),
    mint.toBuffer(),
    bondingCurvePda(mint).toBuffer(),
    user.toBuffer(),
  ];
  if (opts.withCreator) parts.push(creator.toBuffer());
  return { payload: Buffer.concat(parts), mint, creator, user };
}

describe('pump.fun create event decoding', () => {
  test('decodes the current layout including the creator', () => {
    const { payload, mint, creator } = createEventPayload({ withCreator: true });
    const ev = decodeCreateEvent(payload);
    assert.ok(ev);
    assert.equal(ev.mint.toBase58(), mint.toBase58());
    assert.equal(ev.creator.toBase58(), creator.toBase58());
    assert.equal(ev.metadata.symbol, 'TEST');
    assert.equal(ev.metadata.name, 'Test Coin');
    assert.equal(ev.bondingCurve.toBase58(), bondingCurvePda(mint).toBase58());
  });

  test('falls back to the transaction signer when the legacy layout omits creator', () => {
    const { payload, user } = createEventPayload({ withCreator: false });
    const ev = decodeCreateEvent(payload);
    assert.ok(ev);
    assert.equal(ev.creator.toBase58(), user.toBase58());
  });

  test('rejects a payload carrying a different event discriminator', () => {
    const { payload } = createEventPayload({ withCreator: true });
    anchorDiscriminator('event', 'TradeEvent').copy(payload, 0);
    assert.equal(decodeCreateEvent(payload), null);
  });

  test('a truncated payload returns null rather than throwing', () => {
    const { payload } = createEventPayload({ withCreator: true });
    assert.equal(decodeCreateEvent(payload.subarray(0, 40)), null);
    assert.equal(decodeCreateEvent(Buffer.alloc(3)), null);
  });

  test('a hostile string length is rejected, not allocated', () => {
    const bad = Buffer.concat([
      anchorDiscriminator('event', 'CreateEvent'),
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      Buffer.alloc(64),
    ]);
    assert.equal(decodeCreateEvent(bad), null);
  });

  test('extracts every Program data line and ignores the rest', () => {
    const payloads = programDataPayloads([
      'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
      'Program log: Instruction: Create',
      `Program data: ${Buffer.from('hello').toString('base64')}`,
      'Program consumed 12345 of 200000 compute units',
      `Program data: ${Buffer.from('world').toString('base64')}`,
    ]);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0]!.toString(), 'hello');
    assert.equal(payloads[1]!.toString(), 'world');
  });
});

describe('account decoding', () => {
  test('reads a modern bonding curve, creator included', () => {
    const buf = Buffer.alloc(81);
    buf.writeBigUInt64LE(1_073_000_000_000_000n, 8);
    buf.writeBigUInt64LE(30_000_000_000n, 16);
    buf.writeBigUInt64LE(793_100_000_000_000n, 24);
    buf.writeBigUInt64LE(0n, 32);
    buf.writeBigUInt64LE(1_000_000_000_000_000n, 40);
    buf.writeUInt8(0, 48);
    const creator = Keypair.generate().publicKey;
    creator.toBuffer().copy(buf, 49);

    const curve = decodeBondingCurve(buf);
    assert.equal(curve.virtualSol, 30_000_000_000n);
    assert.equal(curve.complete, false);
    assert.equal(curve.creator?.toBase58(), creator.toBase58());
  });

  test('reads the legacy layout and reports no creator', () => {
    const buf = Buffer.alloc(49);
    buf.writeUInt8(1, 48);
    const curve = decodeBondingCurve(buf);
    assert.equal(curve.complete, true);
    assert.equal(curve.creator, null);
  });

  test('an undersized curve account is an error, not a silent zero', () => {
    assert.throws(() => decodeBondingCurve(Buffer.alloc(20)), /too small/);
  });

  test('reads mint authorities and decimals', () => {
    const buf = Buffer.alloc(82);
    const authority = Keypair.generate().publicKey;
    buf.writeUInt32LE(1, 0);
    authority.toBuffer().copy(buf, 4);
    buf.writeBigUInt64LE(1_000_000_000_000_000n, 36);
    buf.writeUInt8(6, 44);
    buf.writeUInt8(1, 45);
    buf.writeUInt32LE(0, 46); // freeze authority renounced

    const mint = decodeMint(buf);
    assert.equal(mint.decimals, 6);
    assert.equal(mint.initialized, true);
    assert.equal(mint.freezeAuthority, null);
    assert.equal(mint.mintAuthority?.toBase58(), authority.toBase58());
  });

  test('reads a token account balance', () => {
    const buf = Buffer.alloc(165);
    buf.writeBigUInt64LE(42_000_000n, 64);
    assert.equal(decodeTokenAmount(buf), 42_000_000n);
  });
});

describe('address derivation', () => {
  test('the bonding curve PDA is deterministic', () => {
    const mint = Keypair.generate().publicKey;
    assert.equal(bondingCurvePda(mint).toBase58(), bondingCurvePda(mint).toBase58());
  });

  test('an off-curve owner needs the explicit opt-in', () => {
    const mint = Keypair.generate().publicKey;
    const curve = bondingCurvePda(mint);
    assert.throws(() => ata(curve, mint), /off-curve/);
    assert.doesNotThrow(() => ata(curve, mint, true));
  });

  test('committed instruction discriminators match the derived ones', () => {
    assert.ok(anchorDiscriminator('global', 'buy').equals(Buffer.from(PUMP_IX.buy)));
    assert.ok(anchorDiscriminator('global', 'sell').equals(Buffer.from(PUMP_IX.sell)));
    assert.ok(anchorDiscriminator('global', 'create').equals(Buffer.from(PUMP_IX.create)));
  });
});

describe('dispatcher', () => {
  const raw = (mint: string, detector: string): Omit<LaunchEvent, 'seq'> => ({
    venue: 'pumpfun',
    mint,
    creator: null,
    signature: `sig-${detector}`,
    slot: 1,
    accounts: {},
    reserves: null,
    seenAt: performance.now(),
    detector,
    metadata: null,
  });

  test('the first detector to report a mint wins', () => {
    const seen: LaunchEvent[] = [];
    const d = new Dispatcher((ev) => seen.push(ev));
    d.submit(raw('MINT_A', 'pumpfun@fast'));
    d.submit(raw('MINT_A', 'pumpfun@slow'));
    d.submit(raw('MINT_A', 'pumpfun@slower'));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.detector, 'pumpfun@fast');
  });

  test('distinct mints all pass through with increasing sequence numbers', () => {
    const seen: LaunchEvent[] = [];
    const d = new Dispatcher((ev) => seen.push(ev));
    d.submit(raw('MINT_A', 'pumpfun@a'));
    d.submit(raw('MINT_B', 'pumpfun@a'));
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.seq, 1);
    assert.equal(seen[1]!.seq, 2);
  });

  test('a throwing consumer does not corrupt dedup state', () => {
    let calls = 0;
    const d = new Dispatcher(() => {
      calls++;
      throw new Error('consumer exploded');
    });
    assert.throws(() => d.submit(raw('MINT_A', 'pumpfun@a')));
    d.submit(raw('MINT_A', 'pumpfun@b')); // deduped, must not call again
    assert.equal(calls, 1);
  });
});
