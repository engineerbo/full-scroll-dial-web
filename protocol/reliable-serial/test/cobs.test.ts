import { describe, expect, test } from 'vitest';
import { encode, decode } from '../src/cobs';

// ── Helpers ───────────────────────────────────────────────────────────────────

function repeat(value: number, count: number): number[] {
  return Array(count).fill(value);
}

// ── Encoding: RFC 1145 / Wikipedia known test vectors ────────────────────────

describe('encode', () => {
  test('empty input → [1]', () => {
    expect(encode([])).toEqual([1]);
  });

  test('[0x00] → [1, 1]', () => {
    expect(encode([0])).toEqual([1, 1]);
  });

  test('[0x00, 0x00] → [1, 1, 1]', () => {
    expect(encode([0, 0])).toEqual([1, 1, 1]);
  });

  test('[11, 22, 0, 33] → [3, 11, 22, 2, 33]', () => {
    expect(encode([11, 22, 0, 33])).toEqual([3, 11, 22, 2, 33]);
  });

  test('[11, 22, 33, 44] → [5, 11, 22, 33, 44]', () => {
    expect(encode([11, 22, 33, 44])).toEqual([5, 11, 22, 33, 44]);
  });

  test('[17, 0, 17, 0] → [2, 17, 2, 17, 1]', () => {
    expect(encode([17, 0, 17, 0])).toEqual([2, 17, 2, 17, 1]);
  });

  test('[0, 0, 0, 0] → [1, 1, 1, 1, 1]', () => {
    expect(encode([0, 0, 0, 0])).toEqual([1, 1, 1, 1, 1]);
  });

  // ── Boundary: 0xFF group size ───────────────────────────────────────────────

  test('253 non-zero bytes fit in one group', () => {
    const data = repeat(0x01, 253);
    const result = encode(data);
    // Overhead byte = 254 (253 data bytes + 1), followed by 253 bytes, no second group needed
    expect(result[0]).toBe(254);
    expect(result.slice(1)).toEqual(data);
    expect(result).toHaveLength(254);
  });

  test('254 non-zero bytes — group of 0xFF + trailing overhead of 1', () => {
    const data = repeat(0x01, 254);
    const result = encode(data);
    // First overhead = 0xFF (254 bytes), then a second overhead byte = 1 (empty group, no trailing zero)
    expect(result[0]).toBe(0xff);
    expect(result.slice(1, 255)).toEqual(data);
    expect(result[255]).toBe(1);
    expect(result).toHaveLength(256);
  });

  test('255 non-zero bytes — group of 0xFF + second group of 2', () => {
    const data = repeat(0x01, 255);
    const result = encode(data);
    expect(result[0]).toBe(0xff);
    expect(result.slice(1, 255)).toEqual(data.slice(0, 254));
    expect(result[255]).toBe(2); // second group overhead: 1 byte follows
    expect(result[256]).toBe(0x01); // the 255th byte
    expect(result).toHaveLength(257);
  });

  test('0xFF overhead signals no implicit zero between groups', () => {
    // 254 ones followed by a zero: the zero triggers a new group *after* the 0xFF block
    const data = [...repeat(0x01, 254), 0x00, 0x42];
    const result = encode(data);
    expect(result[0]).toBe(0xff); // first group: 254 ones
    expect(result[255]).toBe(1); // second group overhead (empty, represents the 0x00)
    expect(result[256]).toBe(2); // third group overhead: 1 byte
    expect(result[257]).toBe(0x42);
  });

  // ── All-zeros input ─────────────────────────────────────────────────────────

  test('N zeros encode to N+1 overhead bytes all equal to 1', () => {
    for (const n of [1, 5, 10]) {
      const result = encode(repeat(0, n));
      expect(result).toEqual(repeat(1, n + 1));
    }
  });
});

// ── Decoding: known vectors and inverses ──────────────────────────────────────

describe('decode', () => {
  test('[1] → []', () => {
    expect(decode([1])).toEqual([]);
  });

  test('[1, 1] → [0]', () => {
    expect(decode([1, 1])).toEqual([0]);
  });

  test('[1, 1, 1] → [0, 0]', () => {
    expect(decode([1, 1, 1])).toEqual([0, 0]);
  });

  test('[3, 11, 22, 2, 33] → [11, 22, 0, 33]', () => {
    expect(decode([3, 11, 22, 2, 33])).toEqual([11, 22, 0, 33]);
  });

  test('[5, 11, 22, 33, 44] → [11, 22, 33, 44]', () => {
    expect(decode([5, 11, 22, 33, 44])).toEqual([11, 22, 33, 44]);
  });

  test('[2, 17, 2, 17, 1] → [17, 0, 17, 0]', () => {
    expect(decode([2, 17, 2, 17, 1])).toEqual([17, 0, 17, 0]);
  });

  test('[1, 1, 1, 1, 1] → [0, 0, 0, 0]', () => {
    expect(decode([1, 1, 1, 1, 1])).toEqual([0, 0, 0, 0]);
  });

  test('0xFF overhead does not insert a zero between groups', () => {
    const encoded = [0xff, ...repeat(0x01, 254), 1];
    const result = decode(encoded);
    expect(result).toEqual(repeat(0x01, 254));
  });

  test('empty input → []', () => {
    expect(decode([])).toEqual([]);
  });

  // ── Error cases ─────────────────────────────────────────────────────────────

  test('zero byte in stream throws', () => {
    expect(() => decode([0x02, 0x01, 0x00])).toThrow('unexpected zero byte');
  });

  test('truncated data throws', () => {
    // Code byte says 5 data bytes follow but only 2 are present
    expect(() => decode([5, 0x01, 0x02])).toThrow('truncated');
  });
});

// ── Round-trip: encode(decode(x)) === x ──────────────────────────────────────

describe('encode/decode round-trip', () => {
  const cases: [string, number[]][] = [
    ['empty', []],
    ['single zero', [0]],
    ['single non-zero', [0x42]],
    ['all zeros (8 bytes)', repeat(0, 8)],
    ['all non-zeros (8 bytes)', repeat(0xab, 8)],
    ['mixed with leading zero', [0, 1, 2, 3]],
    ['mixed with trailing zero', [1, 2, 3, 0]],
    ['mixed with interior zeros', [1, 0, 2, 0, 3]],
    ['consecutive zeros', [0, 0, 0, 1, 0, 0]],
    ['253 non-zeros (one full group)', repeat(0x55, 253)],
    ['254 non-zeros (triggers 0xFF overhead)', repeat(0x55, 254)],
    ['255 non-zeros (two overhead bytes)', repeat(0x55, 255)],
    ['ascending bytes 0–255', Array.from({ length: 256 }, (_, i) => i)],
  ];

  for (const [name, data] of cases) {
    test(name, () => {
      expect(decode(encode(data))).toEqual(data);
    });
  }
});
