/**
 * Parses the payload returned by GET_ALL_STATES.
 *
 * Wire format: repeated [group:u8][cmd:u8][length:u8][value:u8 × length]
 * Returns a Map keyed by the "group-cmd" string used throughout the Poller.
 */
export function parseGetAllStates(data: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  let i = 0;
  while (i + 2 < data.length) {
    const group = data[i]!;
    const cmd = data[i + 1]!;
    const length = data[i + 2]!;
    if (i + 3 + length > data.length) break;
    entries.set(`${group}-${cmd}`, data.slice(i + 3, i + 3 + length));
    i += 3 + length;
  }
  return entries;
}
