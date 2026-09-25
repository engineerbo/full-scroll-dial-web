import { describe, expect, test } from 'vitest';
import {
  encodeSmpHeader,
  decodeSmpHeader,
  type SmpHeader,
} from '../src/smp-header';

// Helper: build a header with safe defaults for fields not under test
function hdr(overrides: Partial<SmpHeader>): SmpHeader {
  return { op: 0, flags: 0, len: 0, group: 0, seq: 0, id: 0, ...overrides };
}

describe('encodeSmpHeader', () => {
  test('all-zero header encodes to 8 zero bytes', () => {
    expect(encodeSmpHeader(hdr({}))).toEqual(
      new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
    );
  });

  test('write request, group=IMAGE(1), id=UPLOAD(1), seq=0, len=64', () => {
    // op=2, flags=0, len=64(0x0040 BE), group=1(0x0001 BE), seq=0, id=1
    expect(encodeSmpHeader(hdr({ op: 2, len: 64, group: 1, id: 1 }))).toEqual(
      new Uint8Array([0x02, 0x00, 0x00, 0x40, 0x00, 0x01, 0x00, 0x01])
    );
  });

  test('read response, group=IMAGE(1), id=STATE(0), seq=42, len=256', () => {
    // op=1, flags=0, len=256(0x0100 BE), group=1(0x0001 BE), seq=42(0x2A), id=0
    expect(
      encodeSmpHeader(hdr({ op: 1, len: 256, group: 1, seq: 42 }))
    ).toEqual(new Uint8Array([0x01, 0x00, 0x01, 0x00, 0x00, 0x01, 0x2a, 0x00]));
  });

  test('len=256 is big-endian: bytes 2–3 are [0x01, 0x00], not [0x00, 0x01]', () => {
    const buf = encodeSmpHeader(hdr({ len: 256 }));
    expect(buf[2]).toBe(0x01); // high byte first
    expect(buf[3]).toBe(0x00);
  });

  test('group=256 is big-endian: bytes 4–5 are [0x01, 0x00]', () => {
    const buf = encodeSmpHeader(hdr({ group: 256 }));
    expect(buf[4]).toBe(0x01);
    expect(buf[5]).toBe(0x00);
  });

  test('seq=255 fits in byte 6', () => {
    expect(encodeSmpHeader(hdr({ seq: 255 }))[6]).toBe(0xff);
  });

  test('group=65535 encodes to [0xff, 0xff] at bytes 4–5', () => {
    const buf = encodeSmpHeader(hdr({ group: 0xffff }));
    expect(buf[4]).toBe(0xff);
    expect(buf[5]).toBe(0xff);
  });

  test('len=65535 encodes to [0xff, 0xff] at bytes 2–3', () => {
    const buf = encodeSmpHeader(hdr({ len: 0xffff }));
    expect(buf[2]).toBe(0xff);
    expect(buf[3]).toBe(0xff);
  });

  test('always returns exactly 8 bytes', () => {
    expect(encodeSmpHeader(hdr({ len: 1000, group: 1, seq: 200 })).length).toBe(
      8
    );
  });

  test('flags byte is written at position 1', () => {
    expect(encodeSmpHeader(hdr({ flags: 0x05 }))[1]).toBe(0x05);
  });
});

describe('decodeSmpHeader', () => {
  test('round-trips all encode test cases', () => {
    const cases: SmpHeader[] = [
      hdr({}),
      hdr({ op: 2, len: 64, group: 1, id: 1 }),
      hdr({ op: 1, len: 256, group: 1, seq: 42 }),
      hdr({ seq: 255 }),
      hdr({ group: 0xffff }),
      hdr({ len: 0xffff }),
      hdr({ flags: 0x05 }),
    ];
    for (const h of cases) {
      expect(decodeSmpHeader(encodeSmpHeader(h))).toEqual(h);
    }
  });

  test('throws RangeError for buffers shorter than 8 bytes', () => {
    expect(() => decodeSmpHeader(new Uint8Array(7))).toThrow(RangeError);
    expect(() => decodeSmpHeader(new Uint8Array(0))).toThrow(RangeError);
  });

  test('ignores extra bytes beyond position 7', () => {
    const extra = new Uint8Array(12);
    extra.set([
      0x02, 0x00, 0x00, 0x40, 0x00, 0x01, 0x00, 0x01, 0xff, 0xff, 0xff, 0xff,
    ]);
    expect(decodeSmpHeader(extra)).toEqual(
      hdr({ op: 2, len: 64, group: 1, id: 1 })
    );
  });

  test('decodes len as big-endian: [0x01, 0x00] at bytes 2–3 → len=256', () => {
    const buf = new Uint8Array(8);
    buf[2] = 0x01;
    buf[3] = 0x00;
    expect(decodeSmpHeader(buf).len).toBe(256);
  });

  test('decodes group as big-endian: [0x00, 0x01] at bytes 4–5 → group=1', () => {
    const buf = new Uint8Array(8);
    buf[4] = 0x00;
    buf[5] = 0x01;
    expect(decodeSmpHeader(buf).group).toBe(1);
  });

  test('all four op codes decode correctly', () => {
    for (const op of [0, 1, 2, 3]) {
      const buf = new Uint8Array(8);
      buf[0] = op;
      expect(decodeSmpHeader(buf).op).toBe(op);
    }
  });
});
