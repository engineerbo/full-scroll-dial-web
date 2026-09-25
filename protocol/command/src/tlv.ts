export function encodeTlv(type: number, value: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + value.length);
  out[0] = type;
  out[1] = value.length;
  out.set(value, 2);
  return out;
}

export function decodeTlv(data: Uint8Array): Map<number, Uint8Array> {
  const map = new Map<number, Uint8Array>();
  let i = 0;
  while (i + 1 < data.length) {
    const type = data[i]!;
    const length = data[i + 1]!;
    if (i + 2 + length > data.length) break;
    map.set(type, data.slice(i + 2, i + 2 + length));
    i += 2 + length;
  }
  return map;
}
