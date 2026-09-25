// Consistent Overhead Byte Stuffing (COBS) — RFC 1145
// Pure ECMAScript; no Node.js built-ins.

export function encode(data: number[]): number[] {
  const output: number[] = [0]; // placeholder for first overhead byte
  let codeIdx = 0;
  let code = 1;

  for (const byte of data) {
    if (byte === 0) {
      output[codeIdx] = code;
      codeIdx = output.length;
      output.push(0);
      code = 1;
    } else {
      output.push(byte);
      code++;
      if (code === 0xff) {
        // 254 consecutive non-zero bytes fills one group; start a new one
        output[codeIdx] = code;
        codeIdx = output.length;
        output.push(0);
        code = 1;
      }
    }
  }

  output[codeIdx] = code;
  return output;
}

export function decode(data: number[]): number[] {
  const output: number[] = [];
  let i = 0;

  while (i < data.length) {
    const code = data[i++]!;
    if (code === 0)
      throw new Error('COBS decode: unexpected zero byte in stream');

    for (let j = 1; j < code; j++) {
      if (i >= data.length) throw new Error('COBS decode: truncated data');
      output.push(data[i++]!);
    }

    // A 0xFF overhead means 254 non-zero bytes with no implicit zero following
    if (code < 0xff && i < data.length) {
      output.push(0);
    }
  }

  return output;
}
