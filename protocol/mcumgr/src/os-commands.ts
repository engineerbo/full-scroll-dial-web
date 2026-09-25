/**
 * OS Management group (Group 0) request builders and response parsers.
 *
 * @see {@link https://docs.zephyrproject.org/latest/services/device_mgmt/smp_groups/smp_group_0.html}
 */

import { encodeSmpHeader } from './smp-header.js';
import { Op, Group, OsCmd } from './constants.js';
import { encode as cborEncode } from 'cborg';

/**
 * Builds a reset request for the OS management group.
 *
 * Sending this frame causes the device to perform a soft reset.
 *
 * @param seq - Sequence number for the SMP header.
 * @returns Raw SMP frame (8-byte header + CBOR payload `{}`).
 */
export function buildOsResetRequest(seq: number): Uint8Array {
  const payload = cborEncode({});
  const header = encodeSmpHeader({
    op: Op.WRITE,
    flags: 0,
    len: payload.length,
    group: Group.OS,
    seq,
    id: OsCmd.RESET,
  });
  const frame = new Uint8Array(header.length + payload.length);
  frame.set(header, 0);
  frame.set(payload, header.length);
  return frame;
}
