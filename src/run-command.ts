import { RESPONSE_STATUS } from '../protocol/command';
import type { Poller } from './poller';
import type { CommandProtocol } from '../protocol/command';

/**
 * Host ARQ retries at 250 ms up to 5 times, so a legitimate recovery from a dropped
 * frame can take ~1.25 s. A 1 s timeout would abort mid-recovery.
 */
export const RUN_COMMAND_TIMEOUT_MS = 2000;

export type RunOutcome =
  | { ok: true; data: Uint8Array }
  | { ok: false; reason: 'timeout' | 'send-failed' }
  | { ok: false; reason: 'error-status'; status: number; data: Uint8Array };

/**
 * One-shot command wrapper that surfaces the response payload, unlike makeSaver()
 * which only reports status. Holds the poller gate for the whole exchange: the
 * reliable-serial layer allows one outstanding frame, so an interleaved poll would
 * make send() throw.
 */
export function makeRunner(
  getPoller: () => Poller | null,
  getProtocol: () => CommandProtocol | null,
  group: number,
  cmd: number,
  label: string,
  timeoutMs = RUN_COMMAND_TIMEOUT_MS
): {
  run: (onOutcome: (outcome: RunOutcome) => void) => boolean;
  cleanup: () => void;
} {
  let cancelCurrent: (() => void) | null = null;

  function run(onOutcome: (outcome: RunOutcome) => void): boolean {
    const protocol = getProtocol();
    if (!protocol) return false;
    if (cancelCurrent) return false;

    const poller = getPoller();
    poller?.beginCommand();
    let done = false;

    const finish = (outcome: RunOutcome): void => {
      done = true;
      clearTimeout(tid);
      protocol.off('response', handler);
      poller?.endCommand();
      cancelCurrent = null;
      onOutcome(outcome);
    };

    const tid = setTimeout(() => {
      if (done) return;
      console.error(`Timeout running ${label}`);
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    const handler = (
      g: number,
      c: number,
      status: number,
      data: Uint8Array
    ): void => {
      if (done || g !== group || c !== cmd) return;
      if (status === RESPONSE_STATUS.SUCCESS) {
        finish({ ok: true, data });
      } else {
        console.error(
          `Failed to run ${label}: error status 0x${status.toString(16).padStart(2, '0')}`
        );
        // The error code travels in the payload, not the status byte
        finish({ ok: false, reason: 'error-status', status, data });
      }
    };

    cancelCurrent = () => {
      if (done) return;
      done = true;
      clearTimeout(tid);
      protocol.off('response', handler);
      poller?.endCommand();
      cancelCurrent = null;
    };

    protocol.on('response', handler);
    try {
      protocol.send(group, cmd);
    } catch (err) {
      console.error(`send() threw for ${label}:`, err);
      finish({ ok: false, reason: 'send-failed' });
    }
    return true;
  }

  return {
    run,
    cleanup() {
      cancelCurrent?.();
    },
  };
}
