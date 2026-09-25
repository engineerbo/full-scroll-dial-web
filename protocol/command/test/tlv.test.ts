import { describe, it, expect } from 'vitest';
import { encodeTlv, decodeTlv } from '../src/tlv';

describe('encodeTlv', () => {
  it('produces a 2-byte output for an empty value', () => {
    const out = encodeTlv(0x05, new Uint8Array([]));
    expect(out.length).toBe(2);
    expect(out[0]).toBe(0x05); // type
    expect(out[1]).toBe(0x00); // length = 0
  });

  it('sets type byte at position 0 and length byte at position 1', () => {
    const out = encodeTlv(0x03, new Uint8Array([0xab]));
    expect(out[0]).toBe(0x03);
    expect(out[1]).toBe(0x01);
  });

  it('places value bytes starting at position 2', () => {
    const value = new Uint8Array([0x01, 0x02, 0x03]);
    const out = encodeTlv(0x07, value);
    expect(out.length).toBe(5);
    expect(out[2]).toBe(0x01);
    expect(out[3]).toBe(0x02);
    expect(out[4]).toBe(0x03);
  });

  it('sets the length byte equal to value.length', () => {
    const value = new Uint8Array(10);
    const out = encodeTlv(0x01, value);
    expect(out[1]).toBe(10);
  });

  it('round-trips correctly: decodeTlv(encodeTlv(t, v)) recovers the original type and value', () => {
    const type = 0x02;
    const value = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const encoded = encodeTlv(type, value);
    const map = decodeTlv(encoded);
    expect(map.has(type)).toBe(true);
    expect(map.get(type)).toEqual(value);
  });
});

describe('decodeTlv', () => {
  it('returns an empty map for an empty buffer', () => {
    expect(decodeTlv(new Uint8Array([]))).toEqual(new Map());
  });

  it('decodes a single TLV entry', () => {
    const data = new Uint8Array([0x01, 0x02, 0xaa, 0xbb]);
    const map = decodeTlv(data);
    expect(map.get(0x01)).toEqual(new Uint8Array([0xaa, 0xbb]));
  });

  it('decodes a zero-length value entry', () => {
    const data = new Uint8Array([0x05, 0x00]);
    const map = decodeTlv(data);
    expect(map.has(0x05)).toBe(true);
    expect(map.get(0x05)!.length).toBe(0);
  });

  it('decodes multiple consecutive TLV entries', () => {
    const data = new Uint8Array([
      0x01,
      0x01,
      0xaa, // type=1, len=1, value=0xaa
      0x02,
      0x02,
      0xbb,
      0xcc, // type=2, len=2, value=[0xbb, 0xcc]
    ]);
    const map = decodeTlv(data);
    expect(map.get(0x01)).toEqual(new Uint8Array([0xaa]));
    expect(map.get(0x02)).toEqual(new Uint8Array([0xbb, 0xcc]));
  });

  it('stops parsing when declared length would overrun the buffer', () => {
    // type=0x01, length=10 but only 2 bytes follow — entry is dropped
    const data = new Uint8Array([0x01, 0x0a, 0xaa, 0xbb]);
    const map = decodeTlv(data);
    expect(map.size).toBe(0);
  });

  it('parses entries that come before a truncated trailing entry', () => {
    const data = new Uint8Array([
      0x01,
      0x01,
      0xff, // complete entry
      0x02,
      0x05,
      0xab, // incomplete — length=5 but only 1 byte follows
    ]);
    const map = decodeTlv(data);
    expect(map.get(0x01)).toEqual(new Uint8Array([0xff]));
    expect(map.has(0x02)).toBe(false);
  });

  it('a single incomplete entry (only type byte present) returns an empty map', () => {
    const data = new Uint8Array([0x01]);
    // i + 1 < data.length → 0 + 1 < 1 → false → loop does not run
    expect(decodeTlv(data).size).toBe(0);
  });
});
