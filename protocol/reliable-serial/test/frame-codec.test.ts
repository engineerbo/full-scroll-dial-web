import { describe, expect, test, beforeEach } from 'vitest';
import { FrameCodec, type DecodeResult } from '../src/frame-codec';

describe('FrameCodec', () => {
  let codec: FrameCodec;

  beforeEach(() => {
    codec = new FrameCodec();
  });

  test('encodes empty frame with CRC correctly', () => {
    const input = new Uint8Array([]);
    const encoded = codec.encodeFrame(input);

    // Empty frame [] -> data string "" -> CRC-32 of "" = 0x00000000
    // [0,0,0,0] with COBS encoding (we'll check the result below)
    // Then we add delimiter

    // Should end with delimiter
    expect(encoded[encoded.length - 1]).toBe(0x00);

    // Should be able to decode it back
    let result: DecodeResult = { status: 'incomplete' };
    for (let i = 0; i < encoded.length; i++) {
      result = codec.decodeByte(encoded[i]);
    }
    expect(result).toMatchObject({ status: 'ok', frame: input });
  });

  test('encodes simple frame with CRC correctly', () => {
    const input = new Uint8Array([0x02, 0x05, 0x00, 0x00]); // Example from spec
    const encoded = codec.encodeFrame(input);

    // Should be longer than input due to CRC and COBS overhead
    expect(encoded.length).toBeGreaterThan(input.length);
    expect(encoded[encoded.length - 1]).toBe(0x00); // Ends with delimiter

    // Should be able to decode it back
    let result: DecodeResult = { status: 'incomplete' };
    for (let i = 0; i < encoded.length; i++) {
      result = codec.decodeByte(encoded[i]);
    }
    expect(result).toMatchObject({ status: 'ok', frame: input });
  });

  test('decodes empty frame correctly', () => {
    const originalData = new Uint8Array([]);
    const encoded = codec.encodeFrame(originalData);

    // Feed each byte to decoder
    let result: DecodeResult = { status: 'incomplete' };
    for (let i = 0; i < encoded.length; i++) {
      result = codec.decodeByte(encoded[i]);
    }

    // Should get back the original data
    expect(result).toMatchObject({ status: 'ok', frame: originalData });
  });

  test('handles partial frame data', () => {
    // Test with simple data [0x01, 0x02, 0x03]
    const originalData = new Uint8Array([0x01, 0x02, 0x03]);
    const encoded = codec.encodeFrame(originalData);

    // Feed bytes one by one except the last few
    let result: DecodeResult = { status: 'incomplete' };
    for (let i = 0; i < encoded.length - 3; i++) {
      result = codec.decodeByte(encoded[i]);
      expect(result.status).toBe('incomplete');
    }

    // Feed remaining bytes
    for (let i = encoded.length - 3; i < encoded.length; i++) {
      result = codec.decodeByte(encoded[i]);
    }

    // Should get back the original data
    expect(result).toMatchObject({ status: 'ok', frame: originalData });
  });

  test('reports corrupt for a frame that COBS-decodes to fewer bytes than CRC_SIZE', () => {
    // Wire bytes [0x02, 0x01, 0x00]: COBS body is [0x02, 0x01], which decodes to
    // [0x01] — 1 byte, less than CRC_SIZE (4) → corrupt.
    codec.decodeByte(0x02);
    codec.decodeByte(0x01);
    const result = codec.decodeByte(0x00);
    expect(result.status).toBe('corrupt');
  });

  test('rejects frames with incorrect CRC', () => {
    const originalData = new Uint8Array([0x01, 0x02, 0x03]);
    const encoded = codec.encodeFrame(originalData);

    // Corrupt one byte in the middle (not the delimiter)
    const corrupted = encoded.slice();
    corrupted[2] = (corrupted[2] + 1) & 0xff;

    // Feed corrupted bytes
    let result: DecodeResult = { status: 'incomplete' };
    for (let i = 0; i < corrupted.length; i++) {
      result = codec.decodeByte(corrupted[i]);
    }

    // Should report corrupt due to CRC mismatch
    expect(result.status).toBe('corrupt');
  });

  test('rejects frames exceeding max size', () => {
    // Create a frame that will exceed MAX_FRAME_SIZE when COBS encoded
    const largeInput = new Uint8Array(300); // Larger than max

    expect(() => {
      codec.encodeFrame(largeInput);
    }).toThrow('COBS encoded frame exceeds MAX_FRAME_SIZE');
  });

  test('resets decoder state properly', () => {
    // Send some data
    codec.decodeByte(0x01);
    codec.decodeByte(0x02);

    // Reset
    codec.reset();

    // Send valid frame
    const originalData = new Uint8Array([0x01, 0x02, 0x03]);
    const encoded = codec.encodeFrame(originalData);

    let result: DecodeResult = { status: 'incomplete' };
    for (let i = 0; i < encoded.length; i++) {
      result = codec.decodeByte(encoded[i]);
    }

    // Should get back the original data
    expect(result).toMatchObject({ status: 'ok', frame: originalData });
  });

  // ── CRC correctness for bytes ≥ 0x80 ──────────────────────────────────────
  // Regression: CRC32.str() mis-encodes bytes ≥ 0x80 as multi-byte UTF-8
  // sequences, producing a CRC that differs from the standard raw-byte CRC-32
  // the firmware computes. CRC32.buf() must be used instead.

  test('round-trips a payload containing bytes >= 0x80', () => {
    const input = new Uint8Array([0x90, 0xab, 0xff, 0x80, 0xc0]);
    const encoded = codec.encodeFrame(input);
    let result: DecodeResult = { status: 'incomplete' };
    for (const byte of encoded) result = codec.decodeByte(byte);
    expect(result).toMatchObject({ status: 'ok', frame: input });
  });

  test('round-trips a payload where all bytes are in 0x80-0xFF', () => {
    const input = new Uint8Array(
      Array.from({ length: 16 }, (_, i) => 0x80 + i)
    );
    const encoded = codec.encodeFrame(input);
    let result: DecodeResult = { status: 'incomplete' };
    for (const byte of encoded) result = codec.decodeByte(byte);
    expect(result).toMatchObject({ status: 'ok', frame: input });
  });

  test('round-trips a frame whose first byte (header) is >= 0x80', () => {
    // seq numbers wrap through 0-255; the protocol engine uses seq as a raw
    // byte in the frame header, so values >= 128 must CRC correctly.
    const input = new Uint8Array([0x02, 0x80, 0x01, 0x00, 0x42]); // DATA, seq=128, len=1, payload=0x42
    const encoded = codec.encodeFrame(input);
    let result: DecodeResult = { status: 'incomplete' };
    for (const byte of encoded) result = codec.decodeByte(byte);
    expect(result).toMatchObject({ status: 'ok', frame: input });
  });

  test('rejects a frame whose payload byte >= 0x80 was corrupted', () => {
    const input = new Uint8Array([0x90, 0xab, 0xff]);
    const encoded = codec.encodeFrame(input);
    const corrupted = encoded.slice();
    corrupted[1] = (corrupted[1] + 1) & 0xff; // flip a byte before the delimiter
    let result: DecodeResult = { status: 'incomplete' };
    for (const byte of corrupted) result = codec.decodeByte(byte);
    expect(result.status).toBe('corrupt');
  });

  // ── Frame size boundary ────────────────────────────────────────────────────
  // dataWithCrc = data + 4 CRC bytes. COBS adds one overhead byte for every
  // 254-byte run of non-zero data. After 253 non-zero bytes, code reaches 254
  // (still < 0xFF); at the 254th byte code hits 0xFF and forces a second
  // overhead byte, pushing encoded.length to 256 ≥ 256 → throw.
  // For a 0x42-filled payload: dataWithCrc = data+4 bytes with the 4 CRC bytes
  // of CRC32(249 × 0x42) all non-zero, so the 253-byte total stays below the
  // single-group limit and encodes to 254 bytes (< 256).

  test('payload of 247 bytes round-trips correctly (comfortably below limit)', () => {
    const input = new Uint8Array(247).fill(0x42);
    const encoded = codec.encodeFrame(input);
    let result: DecodeResult = { status: 'incomplete' };
    for (const byte of encoded) result = codec.decodeByte(byte);
    expect(result).toMatchObject({ status: 'ok', frame: input });
  });

  test('payload of 249 bytes round-trips correctly (near the size limit)', () => {
    const input = new Uint8Array(249).fill(0x42);
    const encoded = codec.encodeFrame(input);
    let result: DecodeResult = { status: 'incomplete' };
    for (const byte of encoded) result = codec.decodeByte(byte);
    expect(result).toMatchObject({ status: 'ok', frame: input });
  });

  test('payload of 250 bytes (all non-zero) exceeds the COBS limit and throws', () => {
    // dataWithCrc = 254 bytes. COBS of 254 non-zero bytes hits the 0xFF group
    // boundary, producing encoded.length = 256 ≥ 256.
    const input = new Uint8Array(250).fill(0x42);
    expect(() => codec.encodeFrame(input)).toThrow(
      'COBS encoded frame exceeds MAX_FRAME_SIZE'
    );
  });

  // ── Sub-CRC-size decoded length ────────────────────────────────────────────
  // The CRC_SIZE guard fires when COBS decodes to < 4 bytes.
  // Wire format for 2 non-zero decoded bytes: [0x03, a, b, 0x00]
  // Wire format for 3 non-zero decoded bytes: [0x04, a, b, c, 0x00]

  test('frame that COBS-decodes to 2 bytes (< CRC_SIZE) is corrupt', () => {
    codec.decodeByte(0x03);
    codec.decodeByte(0x01);
    codec.decodeByte(0x02);
    const result = codec.decodeByte(0x00);
    expect(result.status).toBe('corrupt');
  });

  test('frame that COBS-decodes to 3 bytes (< CRC_SIZE) is corrupt', () => {
    codec.decodeByte(0x04);
    codec.decodeByte(0x01);
    codec.decodeByte(0x02);
    codec.decodeByte(0x03);
    const result = codec.decodeByte(0x00);
    expect(result.status).toBe('corrupt');
  });

  test('decodes multiple consecutive frames correctly', () => {
    const frame1 = new Uint8Array([0x01, 0x02, 0x03]);
    const frame2 = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);

    const encoded1 = codec.encodeFrame(frame1);
    const encoded2 = codec.encodeFrame(frame2);

    // Feed both frames back-to-back through the same decoder instance
    const results: Uint8Array[] = [];
    for (const byte of encoded1) {
      const r = codec.decodeByte(byte);
      if (r.status === 'ok') results.push(r.frame);
    }
    for (const byte of encoded2) {
      const r = codec.decodeByte(byte);
      if (r.status === 'ok') results.push(r.frame);
    }

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(frame1);
    expect(results[1]).toEqual(frame2);
  });
});
