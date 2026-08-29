import { PublicKey } from '@solana/web3.js';

/** Minimal sequential reader for the borsh subset Anchor events use. */
export class BorshReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  skip(n: number): void {
    this.require(n);
    this.offset += n;
  }

  u8(): number {
    this.require(1);
    return this.buf.readUInt8(this.offset++);
  }

  u32(): number {
    this.require(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    this.require(8);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  pubkey(): PublicKey {
    this.require(32);
    const key = new PublicKey(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return key;
  }

  /** Length-prefixed UTF-8. Caps the length so a corrupt log cannot allocate wildly. */
  string(maxLen = 512): string {
    const len = this.u32();
    if (len > maxLen) throw new Error(`string length ${len} exceeds cap ${maxLen}`);
    this.require(len);
    const s = this.buf.subarray(this.offset, this.offset + len).toString('utf8');
    this.offset += len;
    return s;
  }

  private require(n: number): void {
    if (this.offset + n > this.buf.length) {
      throw new Error(`borsh: need ${n} bytes at ${this.offset}, have ${this.remaining}`);
    }
  }
}
