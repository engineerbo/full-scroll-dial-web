import { describe, it, expect } from 'vitest';
import { parseGetAllStates } from '../src/state-parser';

// Helpers
function makeEntry(group: number, cmd: number, ...values: number[]): number[] {
  return [group, cmd, values.length, ...values];
}

function toBytes(...parts: number[][]): Uint8Array {
  return new Uint8Array(parts.flat());
}

describe('parseGetAllStates', () => {
  it('returns an empty Map for an empty buffer', () => {
    const result = parseGetAllStates(new Uint8Array([]));
    expect(result.size).toBe(0);
  });

  it('parses a single entry with a one-byte value', () => {
    const data = toBytes(makeEntry(1, 0, 42));
    const result = parseGetAllStates(data);
    expect(result.size).toBe(1);
    expect(result.get('1-0')).toEqual(new Uint8Array([42]));
  });

  it('keys entries as "group-cmd"', () => {
    const data = toBytes(makeEntry(0, 1, 0));
    const result = parseGetAllStates(data);
    expect(result.has('0-1')).toBe(true);
  });

  it('parses multiple entries', () => {
    const data = toBytes(
      makeEntry(1, 0, 0),
      makeEntry(1, 2, 64),
      makeEntry(1, 4, 1)
    );
    const result = parseGetAllStates(data);
    expect(result.size).toBe(3);
    expect(result.get('1-0')).toEqual(new Uint8Array([0]));
    expect(result.get('1-2')).toEqual(new Uint8Array([64]));
    expect(result.get('1-4')).toEqual(new Uint8Array([1]));
  });

  it('captures the full value slice when length > 1', () => {
    const data = toBytes(makeEntry(0, 2, 10, 20, 30));
    const result = parseGetAllStates(data);
    expect(result.get('0-2')).toEqual(new Uint8Array([10, 20, 30]));
  });

  it('stops parsing when a declared length would overrun the buffer', () => {
    // Entry claims length 5 but only 2 bytes follow
    const data = new Uint8Array([1, 0, 5, 0xff, 0xff]);
    const result = parseGetAllStates(data);
    expect(result.size).toBe(0);
  });

  it('parses entries before a truncated trailing entry', () => {
    const good = makeEntry(1, 0, 7);
    const truncated = [1, 2, 5, 0xff]; // claims 5 bytes but only 1 follows
    const data = toBytes(good, truncated);
    const result = parseGetAllStates(data);
    expect(result.size).toBe(1);
    expect(result.get('1-0')).toEqual(new Uint8Array([7]));
  });

  it('handles a zero-length value entry', () => {
    const data = new Uint8Array([1, 0, 0]);
    const result = parseGetAllStates(data);
    expect(result.size).toBe(1);
    expect(result.get('1-0')).toEqual(new Uint8Array([]));
  });
});
