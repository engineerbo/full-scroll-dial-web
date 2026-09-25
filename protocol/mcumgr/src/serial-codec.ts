/**
 * SMP-over-Serial transport codec.
 *
 * Implements the line-based framing used when SMP runs over a UART.  Framing
 * allows SMP traffic to share a UART with debug console output: the device
 * filters lines by their 2-byte prefix and ignores everything else.
 *
 * ## Packet structure
 *
 * From the SMP Transport specification
 * ({@link https://docs.zephyrproject.org/latest/services/device_mgmt/smp_transport.html}):
 *
 * > "total length [is a] Big endian 16-bit value representing total length of
 * >  body + 2 bytes for CRC16; note that size of total length field is not
 * >  added to total length value."
 *
 * Wire layout before base64 encoding:
 * ```
 * [pktLen: 2 BE][smpFrame: N bytes][crc16: 2 BE]
 * ```
 * where `pktLen = N + 2` (N = SMP frame bytes; +2 for the CRC field).
 *
 * ## Frame size limit
 *
 * > "Currently MCUmgr imposes a 127 byte limit on frame size, although there
 * >  are no real protocol constraints that require that limit.  The limit
 * >  includes the prefix and the newline character, so the allowed payload
 * >  size is actually 124 bytes."
 *
 * > "Body is always Base64 encoded, so the body size, here described as
 * >  MTU - 3, is able to actually carry N = (MTU - 3) / 4 * 3 bytes of raw
 * >  data."
 *
 * With the default MTU of 127:
 * ```
 * maxBase64Chars         = 127 - 3 = 124            (marker[2] + newline[1])
 * maxDecodedBytesPerLine = floor(124 / 4) * 3 = 93
 * ```
 *
 * ## Frame markers
 *
 * > Initial frame (first line of a packet):      prefix `[0x06, 0x09]`
 * > Continuation frame (subsequent lines):        prefix `[0x04, 0x14]`
 * > All frames end with newline `[0x0A]`.
 *
 * ## CRC
 *
 * > "CRC16 polynomial is 0x1021 and initial value is 0."
 * > "The CRC16 included in final type frames is calculated over only raw data
 * >  and does not include packet length."
 *
 * @see {@link https://docs.zephyrproject.org/latest/services/device_mgmt/smp_transport.html}
 */

// ---------------------------------------------------------------------------
// CRC-16/Kermit (ITU-T)
// ---------------------------------------------------------------------------

/**
 * Computes CRC-16/Kermit over `data`, matching Zephyr's `crc16_itu_t()`.
 *
 * From the SMP Transport specification:
 * > "CRC16 polynomial is 0x1021 and initial value is 0."
 * > "The CRC16 included in final type frames is calculated over only raw data
 * >  and does not include packet length."
 *
 * Algorithm (Zephyr `crc16_itu_t()`):
 * ```
 * seed = ((seed >> 8) | (seed << 8)) & 0xFFFF
 * seed ^= byte
 * seed ^= (seed & 0xFF) >> 4
 * seed ^= (seed << 12) & 0xFFFF
 * seed ^= (seed & 0xFF) << 5
 * ```
 * Polynomial 0x1021, init 0x0000.
 * Check value for ASCII "123456789" = 0x31C3.
 * NOTE: this is NOT CRC-16/CCITT-FALSE (init 0xFFFF, check 0x29B1).
 *
 * @param data - Bytes to checksum.
 * @param seed - Initial seed; defaults to 0x0000.  Pass the result of a
 *               previous call to compute a running CRC over multiple chunks.
 * @returns 16-bit CRC value.
 */
export function crc16Kermit(data: Uint8Array, seed = 0x0000): number {
  let s = seed & 0xffff;
  for (const byte of data) {
    s = ((s >> 8) | (s << 8)) & 0xffff;
    s ^= byte & 0xff;
    s ^= (s & 0xff) >> 4;
    s ^= (s << 12) & 0xffff;
    s ^= (s & 0xff) << 5;
    s &= 0xffff;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Line encoder
// ---------------------------------------------------------------------------

/**
 * Encodes a raw SMP frame into the serial line format ready for transmission.
 *
 * Steps:
 * 1. Compute `pktLen = smpFrame.byteLength + 2`.
 * 2. Compute `crc16 = crc16Kermit(smpFrame)` (CRC over the SMP frame only).
 * 3. Assemble `body = [pktLen: 2 BE][smpFrame][crc16: 2 BE]`.
 * 4. Split `body` into chunks of at most `floor((maxFrameSize - 3) / 4) * 3`
 *    decoded bytes each.
 * 5. Base64-encode each chunk.
 * 6. Prepend `[0x06, 0x09]` to the first chunk, `[0x04, 0x14]` to each
 *    subsequent chunk.
 * 7. Append `[0x0A]` (newline) to every chunk.
 * 8. Return all lines concatenated into a single `Uint8Array`.
 *
 * From the SMP Transport specification:
 * > "Currently MCUmgr imposes a 127 byte limit on frame size … The limit
 * >  includes the prefix and the newline character, so the allowed payload
 * >  size is actually 124 bytes."
 *
 * @param smpFrame - Raw SMP frame (8-byte header + CBOR payload).
 * @param maxFrameSize - Total per-line byte budget including marker and
 *   newline; defaults to 127.
 * @returns Concatenated serial lines, ready to write to the port.
 */
export function encodeLines(
  smpFrame: Uint8Array,
  maxFrameSize = 127
): Uint8Array {
  const maxBase64Chars = maxFrameSize - 3; // marker[2] + newline[1]
  const maxBytesPerLine = Math.floor(maxBase64Chars / 4) * 3;
  if (maxBytesPerLine <= 0) {
    throw new Error(
      `maxFrameSize ${maxFrameSize} is too small to encode any data`
    );
  }

  // Build body: [pktLen: 2 BE][smpFrame][crc16: 2 BE]
  const pktLen = smpFrame.byteLength + 2;
  const crc = crc16Kermit(smpFrame);
  const body = new Uint8Array(2 + smpFrame.byteLength + 2);
  const bodyView = new DataView(body.buffer);
  bodyView.setUint16(0, pktLen, false);
  body.set(smpFrame, 2);
  bodyView.setUint16(2 + smpFrame.byteLength, crc, false);

  // Encode into lines
  const lines: Uint8Array[] = [];
  const numLines = Math.ceil(body.length / maxBytesPerLine);
  for (let i = 0; i < numLines; i++) {
    const chunkStart = i * maxBytesPerLine;
    const chunk = body.subarray(chunkStart, chunkStart + maxBytesPerLine);
    const b64 = btoa(String.fromCharCode(...chunk));
    const line = new Uint8Array(3 + b64.length); // marker[2] + b64 + newline[1]
    line[0] = i === 0 ? 0x06 : 0x04;
    line[1] = i === 0 ? 0x09 : 0x14;
    for (let j = 0; j < b64.length; j++) line[2 + j] = b64.charCodeAt(j);
    line[2 + b64.length] = 0x0a;
    lines.push(line);
  }

  const total = lines.reduce((n, l) => n + l.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const line of lines) {
    out.set(line, offset);
    offset += line.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Streaming decoders (TransformStream pipeline)
// ---------------------------------------------------------------------------

/**
 * Creates a `TransformStream` that buffers arbitrary `Uint8Array` chunks from
 * a serial port and emits one complete line per `0x0A` newline.
 *
 * Behaviour:
 * - A line is everything up to and including the `0x0A` byte.
 * - Leading and trailing `0x0D` (carriage-return) bytes are stripped before
 *   the line is enqueued.  At least one Zephyr implementation appends `\r\n`
 *   rather than `\n` alone; the transformer handles both.
 * - Lines that span multiple input chunks are reassembled correctly.
 *
 * Usage in pipeline:
 * ```
 * port.readable.pipeTo(createLineTransformer().writable);
 * ```
 *
 * @returns A `TransformStream<Uint8Array, Uint8Array>` where each output
 *   chunk is one complete, CR-stripped line ending with `0x0A`.
 */
export function createLineTransformer(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  const chunks: Uint8Array[] = [];
  let bufferedLength = 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let start = 0;
      let newlineIdx = chunk.indexOf(0x0a);

      while (newlineIdx !== -1) {
        // Build the line from buffered data + this chunk up to and including \n
        const segLen = newlineIdx - start + 1;
        const line = new Uint8Array(bufferedLength + segLen);
        let offset = 0;
        for (const stored of chunks) {
          line.set(stored, offset);
          offset += stored.length;
        }
        line.set(chunk.subarray(start, newlineIdx + 1), offset);

        // Strip leading 0x0D
        let lo = 0;
        while (lo < line.length && line[lo] === 0x0d) lo++;
        // Strip trailing 0x0D (do not strip the 0x0A at line.length-1)
        let hi = line.length;
        while (hi > lo && line[hi - 1] === 0x0d) hi--;

        controller.enqueue(
          lo === 0 && hi === line.length ? line : line.subarray(lo, hi)
        );

        // Reset buffer state for the next line
        chunks.length = 0;
        bufferedLength = 0;

        start = newlineIdx + 1;
        newlineIdx = chunk.indexOf(0x0a, start);
      }

      // Buffer remaining bytes after the last newline (or the whole chunk if none)
      if (start < chunk.length) {
        const remaining = chunk.subarray(start);
        chunks.push(remaining);
        bufferedLength += remaining.length;
      }
    },
  });
}

/**
 * Creates a `TransformStream` that consumes complete lines (output of
 * {@link createLineTransformer}) and emits decoded SMP frames.
 *
 * Behaviour:
 *
 * 1. A line shorter than 7 bytes is silently discarded (too short to hold a
 *    valid base64 payload).
 * 2. A line beginning `[0x06, 0x09]` starts a new packet.  Any partially
 *    assembled prior packet is discarded.
 * 3. A line beginning `[0x04, 0x14]` continues the current packet.  If no
 *    packet is in progress it is silently discarded.
 * 4. All other lines are silently discarded (debug console output).
 * 5. The bytes after the 2-byte marker, before the trailing `0x0A`, are
 *    base64-decoded and appended to the accumulation buffer.
 * 6. On the initial frame the first two decoded bytes are read as a big-endian
 *    `pktLen`.  Total expected decoded bytes = `pktLen + 2`.
 * 7. When `accumulated == expected`:
 *    - Extract `embeddedCrc = getUint16(last 2 bytes, big-endian)`.
 *    - Extract `smpFrame = decoded bytes [2 .. length-2]`.
 *    - Compute `calculatedCrc = crc16Kermit(smpFrame)`.
 *    - Enqueue `smpFrame` only if CRCs match; silently discard on mismatch.
 * 8. When `accumulated > expected`: discard and reset state.
 *
 * From the SMP Transport specification:
 * > "The CRC16 included in final type frames is calculated over only raw data
 * >  and does not include packet length."
 *
 * @returns A `TransformStream<Uint8Array, Uint8Array>` where each output
 *   chunk is one complete, CRC-verified raw SMP frame.
 */
export function createDeframer(): TransformStream<Uint8Array, Uint8Array> {
  const frameBodies: Uint8Array[] = [];
  let numDecodedBytes = 0;
  let numExpectedBytes = 0;

  function reset() {
    frameBodies.length = 0;
    numDecodedBytes = 0;
    numExpectedBytes = 0;
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Minimum valid line: marker[2] + 4 base64 chars + newline[1] = 7 bytes
      if (chunk.length < 7) return;

      let isStart = false;
      if (chunk[0] === 0x06 && chunk[1] === 0x09) {
        // New packet — discard any partially assembled prior packet
        reset();
        isStart = true;
      } else if (chunk[0] === 0x04 && chunk[1] === 0x14) {
        // Continuation — discard if no packet is in progress
        if (numDecodedBytes === numExpectedBytes) return;
      } else {
        // Not an SMP line (debug console output etc.)
        return;
      }

      // Base64-decode the body: bytes [2 .. length-1] strips marker and trailing \n
      const b64 = String.fromCharCode(...chunk.subarray(2, chunk.length - 1));
      let decoded: Uint8Array;
      try {
        const bin = atob(b64);
        decoded = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) decoded[i] = bin.charCodeAt(i);
      } catch {
        reset();
        return;
      }

      if (isStart) {
        if (decoded.length < 2) {
          reset();
          return;
        }
        const view = new DataView(decoded.buffer, decoded.byteOffset);
        const pktLen = view.getUint16(0, false); // big-endian
        numExpectedBytes = pktLen + 2; // pktLen + the 2-byte length field itself
        numDecodedBytes = decoded.length;
        frameBodies.push(decoded);
      } else {
        frameBodies.push(decoded);
        numDecodedBytes += decoded.length;
      }

      if (numDecodedBytes === numExpectedBytes) {
        // Reassemble the full packet buffer
        const packet = new Uint8Array(numDecodedBytes);
        let off = 0;
        for (const body of frameBodies) {
          packet.set(body, off);
          off += body.length;
        }
        const pktView = new DataView(packet.buffer);
        const embeddedCrc = pktView.getUint16(packet.length - 2, false);
        const smpFrame = packet.subarray(2, packet.length - 2);
        const calculatedCrc = crc16Kermit(smpFrame);
        if (calculatedCrc === embeddedCrc) {
          controller.enqueue(smpFrame.slice()); // copy so buffer can be freed
        }
        reset();
      } else if (numDecodedBytes > numExpectedBytes) {
        reset();
      }
    },
    flush() {
      // Stream closing with an incomplete packet — discard partial state
      reset();
    },
  });
}
