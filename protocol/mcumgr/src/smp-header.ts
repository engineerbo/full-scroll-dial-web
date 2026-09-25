/**
 * SMP (Simple Management Protocol) 8-byte header encoding and decoding.
 *
 * ## Header layout (v0, Ver=0b00)
 *
 * From the SMP protocol specification
 * ({@link https://docs.zephyrproject.org/latest/services/device_mgmt/smp_protocol.html}):
 *
 * ```
 * Offset  Size  Field
 * 0       1     OP     — read/write + request/response
 * 1       1     Flags  — "Reserved for flags; there are no flags defined yet,
 *                          the field should be set to 0"
 * 2–3     2     Len    — "Length of the Data field" (big-endian)
 * 4–5     2     Group  — management group ID (big-endian)
 * 6       1     Seq    — sequence number
 * 7       1     ID     — command within group
 * ```
 *
 * Sequence number:
 * > "The number is increased by one with each request frame. The Sequence Num
 * >  of a response should match the one in the request."
 *
 * ## SMP version note
 *
 * Newer firmware (v1+) packs `Res(1 bit) | Ver(2 bits) | OP(5 bits)` into
 * byte 0. This implementation targets **v0** where byte 0 is the full op code
 * with no version bits. A response with an unrecognised op byte indicates a
 * v1+ device; the caller should handle or discard such frames.
 *
 * @see {@link https://docs.zephyrproject.org/latest/services/device_mgmt/smp_protocol.html}
 */

export interface SmpHeader {
  /** Op code. One of {@link Op} values. Occupies byte 0. */
  op: number;
  /**
   * Flags byte. From the spec:
   * > "Reserved for flags; there are no flags defined yet, the field should be set to 0."
   * Occupies byte 1.
   */
  flags: number;
  /**
   * Byte length of the CBOR payload that follows the header.
   * Encoded big-endian at bytes 2–3.
   * Must equal `frame.length - 8` for any built SMP frame.
   */
  len: number;
  /**
   * Management group ID. See {@link Group}.
   * Encoded big-endian at bytes 4–5.
   */
  group: number;
  /**
   * Sequence number, 0–255, wrapping.
   * > "The number is increased by one with each request frame.
   * >  The Sequence Num of a response should match the one in the request."
   * Occupies byte 6.
   */
  seq: number;
  /** Command ID within the group. See {@link ImgCmd}, {@link OsCmd}. Occupies byte 7. */
  id: number;
}

/**
 * Encodes an {@link SmpHeader} into the 8-byte on-wire representation.
 *
 * Byte layout:
 * ```
 * [op][flags][len_hi][len_lo][group_hi][group_lo][seq][id]
 * ```
 * `len` and `group` are written big-endian (network byte order).
 *
 * @param header - Header fields to encode.
 * @returns Exactly 8 bytes.
 */
export function encodeSmpHeader(header: SmpHeader): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  buf[0] = header.op & 0xff;
  buf[1] = header.flags & 0xff;
  view.setUint16(2, header.len, false); // big-endian
  view.setUint16(4, header.group, false); // big-endian
  buf[6] = header.seq & 0xff;
  buf[7] = header.id & 0xff;
  return buf;
}

/**
 * Decodes the first 8 bytes of `buf` into an {@link SmpHeader}.
 *
 * @param buf - Must be at least 8 bytes; extra bytes are ignored.
 * @returns Decoded header.
 * @throws {RangeError} if `buf.length < 8`.
 */
export function decodeSmpHeader(buf: Uint8Array): SmpHeader {
  if (buf.length < 8) {
    throw new RangeError(
      `Buffer too short: expected ≥8 bytes, got ${buf.length}`
    );
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    op: buf[0]!,
    flags: buf[1]!,
    len: view.getUint16(2, false), // big-endian
    group: view.getUint16(4, false), // big-endian
    seq: buf[6]!,
    id: buf[7]!,
  };
}
