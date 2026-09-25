import { describe, expect, test } from 'vitest';
import { FrameCodec, type DecodeResult } from '../src/frame-codec';
import CRC32 from 'crc-32';

describe('Spec Validation', () => {
  // ── Section 15.1: SYNC frame wire format ──────────────────────────────────

  test('SYNC frame round-trips correctly', () => {
    const codec = new FrameCodec();
    const syncFrame = new Uint8Array([0x00]);
    const encoded = codec.encodeFrame(syncFrame);

    expect(encoded[encoded.length - 1]).toBe(0x00); // must end with delimiter

    let decoded: DecodeResult = { status: 'incomplete' };
    for (const byte of encoded) decoded = codec.decodeByte(byte);
    expect(decoded).toMatchObject({ status: 'ok', frame: syncFrame });
  });

  test('SYNC frame has correct wire-format structure (spec section 15.1)', () => {
    const codec = new FrameCodec();
    const encoded = codec.encodeFrame(new Uint8Array([0x00]));

    // Pre-COBS: [0x00, crc0, crc1, crc2, crc3] (5 bytes)
    // COBS of [0x00, ...4 non-zero CRC bytes]: first overhead=1, second overhead=5
    // + delimiter → 7 bytes total
    expect(encoded.length).toBe(7);
    expect(encoded[0]).toBe(0x01); // COBS: empty group before the 0x00
    expect(encoded[1]).toBe(0x05); // COBS: 4-byte group (CRC bytes) after the 0x00
    expect(encoded[6]).toBe(0x00); // delimiter

    // Verify bytes 2-5 are CRC-32/ISO-HDLC of [0x00] in little-endian.
    // Note: the spec's example CRC [0xD8,0xE2,0xF0,0xE9] appears to be illustrative;
    // the correct CRC-32/ISO-HDLC of [0x00] is 0xD202EF8D.
    const crc = CRC32.str('\x00');
    const expectedCrcBytes = [
      crc & 0xff,
      (crc >> 8) & 0xff,
      (crc >> 16) & 0xff,
      (crc >> 24) & 0xff,
    ];
    expect(Array.from(encoded.slice(2, 6))).toEqual(expectedCrcBytes);
  });

  // ── ACK_SYNC frame wire format ────────────────────────────────────────────

  test('ACK_SYNC frame round-trips correctly', () => {
    const codec = new FrameCodec();
    const ackSyncFrame = new Uint8Array([0x01]); // FrameID.ACK_SYNC
    const encoded = codec.encodeFrame(ackSyncFrame);

    expect(encoded[encoded.length - 1]).toBe(0x00);

    let decoded: DecodeResult = { status: 'incomplete' };
    for (const byte of encoded) decoded = codec.decodeByte(byte);
    expect(decoded).toMatchObject({ status: 'ok', frame: ackSyncFrame });
  });

  // ── ACK frame wire format ─────────────────────────────────────────────────

  test('ACK frame round-trips correctly', () => {
    const codec = new FrameCodec();
    const ackFrame = new Uint8Array([0x02, 0x05]); // FrameID.ACK, seq=5
    const encoded = codec.encodeFrame(ackFrame);

    expect(encoded[encoded.length - 1]).toBe(0x00);

    let decoded: DecodeResult = { status: 'incomplete' };
    for (const byte of encoded) decoded = codec.decodeByte(byte);
    expect(decoded).toMatchObject({ status: 'ok', frame: ackFrame });
  });

  // ── Section 15.2: DATA frame wire format ─────────────────────────────────

  test('DATA frame round-trips correctly', () => {
    const codec = new FrameCodec();
    // Data { seq: 5, payload: [0x41, 0x42] } → unencoded [0x03, 0x05, 0x02, 0x00, 0x41, 0x42]
    const unencoded = new Uint8Array([0x03, 0x05, 0x02, 0x00, 0x41, 0x42]);
    const encoded = codec.encodeFrame(unencoded);

    expect(encoded[encoded.length - 1]).toBe(0x00);

    let decoded: DecodeResult = { status: 'incomplete' };
    for (const byte of encoded) decoded = codec.decodeByte(byte);
    expect(decoded).toMatchObject({ status: 'ok', frame: unencoded });
  });
});
