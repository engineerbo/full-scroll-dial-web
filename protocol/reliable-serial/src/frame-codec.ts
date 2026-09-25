import { encode as cobsEncode, decode as cobsDecode } from './cobs';
import CRC32 from 'crc-32';

export type DecodeResult =
  | { status: 'incomplete' }
  | { status: 'ok'; frame: Uint8Array }
  | { status: 'corrupt' };

export class FrameCodec {
  private buffer: number[];
  private static readonly CRC_SIZE = 4;

  constructor() {
    this.buffer = [];
  }

  encodeFrame(data: Uint8Array): Uint8Array {
    const crc = CRC32.buf(data);

    // CRC-32 appended in little-endian byte order (LSB first) to match firmware.
    const crcBytes = [
      crc & 0xff,
      (crc >> 8) & 0xff,
      (crc >> 16) & 0xff,
      (crc >> 24) & 0xff,
    ];

    const dataWithCrc = [...Array.from(data), ...crcBytes];
    const encoded = cobsEncode(dataWithCrc);

    // Total wire frame is encoded.length + 1 (delimiter); must not exceed MAX_FRAME_SIZE (256)
    if (encoded.length >= 256) {
      throw new Error('COBS encoded frame exceeds MAX_FRAME_SIZE (256 bytes)');
    }

    const output = new Uint8Array(encoded.length + 1);
    output.set(encoded);
    output[encoded.length] = 0x00;

    return output;
  }

  decodeByte(byte: number): DecodeResult {
    this.buffer.push(byte);

    if (byte !== 0x00) {
      return { status: 'incomplete' };
    }

    const frameData = this.buffer.slice(0, -1);
    this.buffer = [];

    try {
      const decoded = cobsDecode(frameData);

      if (decoded.length < FrameCodec.CRC_SIZE) {
        return { status: 'corrupt' };
      }

      const dataWithoutCrc = decoded.slice(0, -FrameCodec.CRC_SIZE);
      const crcBytes = decoded.slice(-FrameCodec.CRC_SIZE);

      const receivedCrc =
        crcBytes[0]! |
        (crcBytes[1]! << 8) |
        (crcBytes[2]! << 16) |
        (crcBytes[3]! << 24);

      const calculatedCrc = CRC32.buf(dataWithoutCrc);

      if (receivedCrc !== calculatedCrc) {
        return { status: 'corrupt' };
      }

      return { status: 'ok', frame: new Uint8Array(dataWithoutCrc) };
    } catch {
      return { status: 'corrupt' };
    }
  }

  reset(): void {
    this.buffer = [];
  }
}
