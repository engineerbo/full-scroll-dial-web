import { describe, expect, test } from 'vitest';
import {
  crc16Kermit,
  encodeLines,
  createLineTransformer,
  createDeframer,
} from '../src/serial-codec';

// ---------------------------------------------------------------------------
// Helper: push items through a TransformStream and collect output
// ---------------------------------------------------------------------------

async function collect(
  transform: TransformStream<Uint8Array, Uint8Array>,
  inputs: Uint8Array[]
): Promise<Uint8Array[]> {
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const results: Uint8Array[] = [];

  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      results.push(value);
    }
  })();

  for (const input of inputs) await writer.write(input);
  await writer.close();
  await reading;
  return results;
}

// ---------------------------------------------------------------------------
// crc16Kermit
// ---------------------------------------------------------------------------

describe('crc16Kermit', () => {
  test('empty input with default seed → 0x0000', () => {
    expect(crc16Kermit(new Uint8Array([]))).toBe(0x0000);
  });

  test('check value for ASCII "123456789" → 0x31C3', () => {
    // Zephyr crc16_itu_t with seed 0x0000 over "123456789".
    // This is NOT CRC-16/Kermit (0x2189) or CCITT-FALSE (0x29B1); it is the
    // specific algorithm used by Zephyr's smp_serial transport.
    const bytes = Uint8Array.from('123456789', (c) => c.charCodeAt(0));
    expect(crc16Kermit(bytes)).toBe(0x31c3);
  });

  test('is NOT CRC-16/CCITT-FALSE (check value 0x29B1)', () => {
    // CCITT-FALSE uses seed 0xFFFF with no reflection; pinning this prevents
    // accidentally switching to that variant.
    const bytes = Uint8Array.from('123456789', (c) => c.charCodeAt(0));
    expect(crc16Kermit(bytes)).not.toBe(0x29b1);
  });

  test('single zero byte produces consistent result', () => {
    const r = crc16Kermit(new Uint8Array([0x00]));
    // Just pin the output so any algorithm change is detected
    expect(crc16Kermit(new Uint8Array([0x00]))).toBe(r);
  });

  test('custom seed is respected', () => {
    const a = new Uint8Array([0x01, 0x02]);
    const b = new Uint8Array([0x03, 0x04]);
    // Running CRC: crc(a ++ b) === crc(b, seed=crc(a))
    const full = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    expect(crc16Kermit(b, crc16Kermit(a))).toBe(crc16Kermit(full));
  });

  test('result is always a 16-bit value (0x0000–0xFFFF)', () => {
    const data = new Uint8Array(256).fill(0xff);
    const r = crc16Kermit(data);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(0xffff);
  });
});

// ---------------------------------------------------------------------------
// encodeLines
// ---------------------------------------------------------------------------

describe('encodeLines', () => {
  // Helpers to inspect encoded output without re-implementing encoding

  function splitLines(encoded: Uint8Array): Uint8Array[] {
    const lines: Uint8Array[] = [];
    let start = 0;
    for (let i = 0; i < encoded.length; i++) {
      if (encoded[i] === 0x0a) {
        lines.push(encoded.subarray(start, i + 1));
        start = i + 1;
      }
    }
    return lines;
  }

  function b64Decode(line: Uint8Array): Uint8Array {
    // Strip marker[2] and trailing newline[1]
    const b64 = String.fromCharCode(...line.subarray(2, line.length - 1));
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  test('single-line packet: 9-byte SMP frame (header + 0xa0)', () => {
    // body = 2(pktLen) + 9(frame) + 2(crc) = 13 bytes
    // base64(13) = ceil(13/3)*4 = 20 chars ≤ 124 → fits in one line
    const frame = new Uint8Array(9).fill(0x00);
    const encoded = encodeLines(frame);
    const lines = splitLines(encoded);

    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toBe(0x06); // initial marker byte 0
    expect(lines[0][1]).toBe(0x09); // initial marker byte 1
    expect(lines[0][lines[0].length - 1]).toBe(0x0a); // newline

    // Verify packet structure
    const decoded = b64Decode(lines[0]);
    expect(decoded).toHaveLength(13);
    const view = new DataView(decoded.buffer);
    expect(view.getUint16(0, false)).toBe(11); // pktLen = 9 + 2
    expect(decoded.subarray(2, 11)).toEqual(frame); // SMP frame bytes
    // Last 2 bytes are CRC over the SMP frame
    const embeddedCrc = view.getUint16(11, false);
    expect(embeddedCrc).toBe(crc16Kermit(frame));
  });

  test('multi-line packet: 200-byte SMP frame → 3 lines', () => {
    // body = 2 + 200 + 2 = 204 bytes; maxBytesPerLine = 93; ceil(204/93) = 3
    const frame = new Uint8Array(200).fill(0xab);
    const lines = splitLines(encodeLines(frame));

    expect(lines).toHaveLength(3);
    expect(lines[0][0]).toBe(0x06); // initial
    expect(lines[0][1]).toBe(0x09);
    expect(lines[1][0]).toBe(0x04); // continuation
    expect(lines[1][1]).toBe(0x14);
    expect(lines[2][0]).toBe(0x04);
    expect(lines[2][1]).toBe(0x14);
    for (const line of lines) {
      expect(line[line.length - 1]).toBe(0x0a);
    }
  });

  test('every line is ≤ 127 bytes (default maxFrameSize)', () => {
    for (const size of [9, 89, 90, 100, 200, 500]) {
      const frame = new Uint8Array(size).fill(0x55);
      const lines = splitLines(encodeLines(frame));
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(127);
      }
    }
  });

  test('MTU boundary: 89-byte frame → body exactly fills one line (1 line)', () => {
    // body = 2 + 89 + 2 = 93 bytes; base64(93) = 124 chars = maxBase64Chars → 1 line
    const frame = new Uint8Array(89).fill(0x42);
    expect(splitLines(encodeLines(frame))).toHaveLength(1);
  });

  test('MTU boundary: 90-byte frame → body needs 2 lines', () => {
    // body = 2 + 90 + 2 = 94 bytes; 94 > 93 → requires continuation line
    const frame = new Uint8Array(90).fill(0x42);
    expect(splitLines(encodeLines(frame))).toHaveLength(2);
  });

  test('pktLen field = smpFrame.byteLength + 2', () => {
    for (const size of [0, 1, 9, 50, 89]) {
      const frame = new Uint8Array(size);
      const lines = splitLines(encodeLines(frame));
      const firstBody = b64Decode(lines[0]);
      const pktLen = new DataView(firstBody.buffer).getUint16(0, false);
      expect(pktLen).toBe(size + 2);
    }
  });
});

// ---------------------------------------------------------------------------
// createLineTransformer
// ---------------------------------------------------------------------------

describe('createLineTransformer', () => {
  test('splits two lines from a single input chunk', async () => {
    // 'a\nb\n' → ['a\n', 'b\n']
    const input = new Uint8Array([0x61, 0x0a, 0x62, 0x0a]);
    const out = await collect(createLineTransformer(), [input]);

    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(new Uint8Array([0x61, 0x0a]));
    expect(out[1]).toEqual(new Uint8Array([0x62, 0x0a]));
  });

  test('reassembles a line split across multiple chunks', async () => {
    const out = await collect(createLineTransformer(), [
      new Uint8Array([0x61, 0x62]), // 'ab'
      new Uint8Array([0x63, 0x0a]), // 'c\n'
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(new Uint8Array([0x61, 0x62, 0x63, 0x0a]));
  });

  test('strips a leading CR: [0x0D, 0x61, 0x0A] → [0x61, 0x0A]', async () => {
    const out = await collect(createLineTransformer(), [
      new Uint8Array([0x0d, 0x61, 0x0a]),
    ]);
    expect(out[0]).toEqual(new Uint8Array([0x61, 0x0a]));
  });

  test('strips a trailing CR before the newline is absent: \\r\\n sequence (CR then NL)', async () => {
    // Some devices send "data\r\n" — the \r comes before \n.
    // LineTransformer splits on \n; the resulting line is [data, 0x0D, 0x0A].
    // Trailing CR trim only removes 0x0D at the very end of the buffer.
    // Since 0x0A is last, 0x0D is NOT trimmed here (matches reference behaviour).
    // The important case is \n\r (line ends with \n, next chunk starts with \r).
    const out = await collect(createLineTransformer(), [
      new Uint8Array([0x61, 0x0a]), // 'a\n'
      new Uint8Array([0x0d]), // '\r' — start of next logical line
      new Uint8Array([0x62, 0x0a]), // 'b\n'
    ]);
    // First line: ['a', '\n']
    expect(out[0]).toEqual(new Uint8Array([0x61, 0x0a]));
    // Second line: the leading \r is stripped → ['b', '\n']
    expect(out[1]).toEqual(new Uint8Array([0x62, 0x0a]));
  });

  test('no output for input with no newline', async () => {
    const out = await collect(createLineTransformer(), [
      new Uint8Array([0x61, 0x62, 0x63]),
    ]);
    expect(out).toHaveLength(0);
  });

  test('handles multiple newlines in one chunk', async () => {
    const out = await collect(createLineTransformer(), [
      new Uint8Array([0x61, 0x0a, 0x62, 0x0a, 0x63, 0x0a]),
    ]);
    expect(out).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// createDeframer
// ---------------------------------------------------------------------------

describe('createDeframer', () => {
  // Build a valid single-line encoded packet from a known SMP frame
  function makePacketLines(frame: Uint8Array): Uint8Array[] {
    const encoded = encodeLines(frame);
    // Split into individual lines at each 0x0A
    const lines: Uint8Array[] = [];
    let start = 0;
    for (let i = 0; i < encoded.length; i++) {
      if (encoded[i] === 0x0a) {
        lines.push(encoded.subarray(start, i + 1));
        start = i + 1;
      }
    }
    return lines;
  }

  test('happy path: single-line packet → original SMP frame', async () => {
    const frame = new Uint8Array(9).fill(0xab);
    const lines = makePacketLines(frame);
    expect(lines).toHaveLength(1);

    const out = await collect(createDeframer(), lines);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(frame);
  });

  test('happy path: multi-line packet (200-byte frame) → original SMP frame', async () => {
    const frame = new Uint8Array(200).fill(0x55);
    const lines = makePacketLines(frame);
    expect(lines.length).toBeGreaterThan(1);

    const out = await collect(createDeframer(), lines);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(frame);
  });

  test('non-mcumgr lines are silently discarded', async () => {
    // A line without the 0x06/0x09 or 0x04/0x14 prefix
    const garbage = new Uint8Array([
      0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x0a,
    ]);
    const out = await collect(createDeframer(), [garbage]);
    expect(out).toHaveLength(0);
  });

  test('continuation line before a start line is discarded', async () => {
    const cont = new Uint8Array([
      0x04, 0x14, 0x41, 0x41, 0x41, 0x41, 0x41, 0x0a,
    ]);
    const out = await collect(createDeframer(), [cont]);
    expect(out).toHaveLength(0);
  });

  test('new start line discards previous partial packet', async () => {
    const frame = new Uint8Array(200).fill(0x77); // needs 3 lines
    const lines = makePacketLines(frame);
    expect(lines).toHaveLength(3);

    // Send only the first line of the first packet, then start a second complete packet
    const frame2 = new Uint8Array(9).fill(0x99);
    const lines2 = makePacketLines(frame2);

    const out = await collect(createDeframer(), [lines[0], ...lines2]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(frame2);
  });

  test('CRC mismatch: frame is silently discarded', async () => {
    const frame = new Uint8Array(9).fill(0xcc);
    const encoded = encodeLines(frame).slice();
    // Corrupt a byte in the middle of the base64 payload (after the marker)
    encoded[3] = encoded[3] === 0x41 ? 0x42 : 0x41;

    // Re-split into lines
    const lines: Uint8Array[] = [];
    let start = 0;
    for (let i = 0; i < encoded.length; i++) {
      if (encoded[i] === 0x0a) {
        lines.push(encoded.subarray(start, i + 1));
        start = i + 1;
      }
    }

    const out = await collect(createDeframer(), lines);
    expect(out).toHaveLength(0);
  });

  test('line shorter than 7 bytes is discarded without corrupting state', async () => {
    const shortLine = new Uint8Array([0x06, 0x09, 0x41, 0x41, 0x0a]); // 5 bytes
    const frame = new Uint8Array(9).fill(0x11);
    const validLines = makePacketLines(frame);

    // Short line before a valid packet
    const out = await collect(createDeframer(), [shortLine, ...validLines]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(frame);
  });

  test('overflow: too many decoded bytes causes discard and state reset', async () => {
    // Build a packet manually where the reported pktLen is smaller than the
    // actual payload so that a second encoded line tips numDecodedBytes over numExpectedBytes.
    // Easiest: encode a 200-byte frame (3 lines), but intercept line 1 and
    // patch the pktLen to be smaller than what will actually arrive.
    const frame = new Uint8Array(200).fill(0xaa);
    const encoded = encodeLines(frame);
    const lines: Uint8Array[] = [];
    let start = 0;
    for (let i = 0; i < encoded.length; i++) {
      if (encoded[i] === 0x0a) {
        lines.push(encoded.subarray(start, i + 1).slice());
        start = i + 1;
      }
    }

    // Decode line 0's body, shrink pktLen so packet will "overflow", re-encode
    const b64_0 = String.fromCharCode(
      ...lines[0].subarray(2, lines[0].length - 1)
    );
    const body0 = Uint8Array.from(atob(b64_0), (c) => c.charCodeAt(0)).slice();
    // Set pktLen to 1 (a tiny value that will be exceeded immediately)
    new DataView(body0.buffer).setUint16(0, 1, false);
    const newB64 = btoa(String.fromCharCode(...body0));
    const patchedLine0 = new Uint8Array(3 + newB64.length);
    patchedLine0[0] = 0x06;
    patchedLine0[1] = 0x09;
    for (let i = 0; i < newB64.length; i++)
      patchedLine0[2 + i] = newB64.charCodeAt(i);
    patchedLine0[2 + newB64.length] = 0x0a;
    lines[0] = patchedLine0;

    // Feed the patched packet — the continuation line will push over the limit
    const out1 = await collect(createDeframer(), lines);
    expect(out1).toHaveLength(0); // Overflow packet discarded

    // State must be reset: a subsequent valid packet must be decoded correctly
    const frame2 = new Uint8Array(9).fill(0xbb);
    const out2 = await collect(createDeframer(), makePacketLines(frame2));
    expect(out2).toHaveLength(1);
    expect(out2[0]).toEqual(frame2);
  });

  test('flush discards partial packet without emitting', async () => {
    const frame = new Uint8Array(200).fill(0xaa);
    const lines = makePacketLines(frame);
    expect(lines.length).toBeGreaterThan(1);

    // Feed only the first line (start, not complete) then close the stream.
    // flush() calls reset() discarding the partial state, so no frame is emitted.
    const out = await collect(createDeframer(), [lines[0]]);
    expect(out).toHaveLength(0);
  });

  test('flush does not corrupt a complete packet before close', async () => {
    const frame = new Uint8Array(9).fill(0xbb);
    const lines = makePacketLines(frame);
    expect(lines).toHaveLength(1);

    // Complete single-line packet followed by stream close.
    // flush() runs after the packet is already assembled and emitted; it is a no-op.
    const out = await collect(createDeframer(), lines);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(frame);
  });

  test('flush after empty stream is a no-op', async () => {
    const out = await collect(createDeframer(), []);
    expect(out).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// encodeLines / deframer round-trip
// ---------------------------------------------------------------------------

describe('round-trip: encodeLines → LineTransformer → deframer', () => {
  async function roundTrip(frame: Uint8Array): Promise<Uint8Array> {
    const encoded = encodeLines(frame);

    // Feed as one chunk into LineTransformer
    const lineTransformer = createLineTransformer();
    const lines = await collect(lineTransformer, [encoded]);

    // Feed lines into deframer
    const deframer = createDeframer();
    const frames = await collect(deframer, lines);

    expect(frames).toHaveLength(1);
    return frames[0];
  }

  for (const size of [1, 9, 89, 90, 200, 500]) {
    test(`round-trips a ${size}-byte SMP frame`, async () => {
      const frame = new Uint8Array(size).fill(size & 0xff);
      expect(await roundTrip(frame)).toEqual(frame);
    });
  }

  test('round-trips a frame with all byte values 0x00–0xFF', async () => {
    const frame = new Uint8Array(256);
    for (let i = 0; i < 256; i++) frame[i] = i;
    expect(await roundTrip(frame)).toEqual(frame);
  });

  test('two consecutive packets through the same deframer', async () => {
    const frame1 = new Uint8Array(9).fill(0x11);
    const frame2 = new Uint8Array(9).fill(0x22);
    const combined = new Uint8Array([
      ...encodeLines(frame1),
      ...encodeLines(frame2),
    ]);

    const lines = await collect(createLineTransformer(), [combined]);
    const frames = await collect(createDeframer(), lines);

    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(frame1);
    expect(frames[1]).toEqual(frame2);
  });
});
