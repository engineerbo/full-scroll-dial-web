import { RESPONSE_STATUS } from '../protocol/command';
import { setFieldStatus } from './field-status';
import type { Poller } from './poller';
import type { CommandProtocol } from '../protocol/command';

export function makeSaver(
  getPoller: () => Poller | null,
  getProtocol: () => CommandProtocol | null,
  group: number,
  cmd: number,
  dot: HTMLSpanElement,
  text: HTMLSpanElement,
  label: string,
  timeoutMs = 1000
): {
  save: (
    payload: Uint8Array,
    onSuccess?: () => void,
    onFailure?: () => void
  ) => void;
  cleanup: () => void;
} {
  let cancelCurrent: (() => void) | null = null;

  function save(
    payload: Uint8Array,
    onSuccess?: () => void,
    onFailure?: () => void
  ): void {
    const protocol = getProtocol();
    if (!protocol) return;
    if (cancelCurrent) return;

    const poller = getPoller();
    poller?.beginCommand();
    let done = false;

    const tid = setTimeout(() => {
      if (done) return;
      done = true;
      protocol.off('response', handler);
      poller?.endCommand();
      cancelCurrent = null;
      setFieldStatus(dot, text, 'error', 'Save failed');
      console.error(`Timeout setting ${label}`);
      onFailure?.();
    }, timeoutMs);

    const handler = (g: number, c: number, status: number) => {
      if (done || g !== group || c !== cmd) return;
      done = true;
      clearTimeout(tid);
      protocol.off('response', handler);
      poller?.endCommand();
      cancelCurrent = null;
      if (status === RESPONSE_STATUS.SUCCESS) {
        setFieldStatus(dot, text, 'success', 'Saved', true);
        onSuccess?.();
      } else {
        setFieldStatus(dot, text, 'error', 'Save failed');
        console.error(
          `Failed to set ${label}: error status 0x${status.toString(16).padStart(2, '0')}`
        );
        onFailure?.();
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
      protocol.send(group, cmd, payload);
    } catch (err) {
      done = true;
      clearTimeout(tid);
      protocol.off('response', handler);
      poller?.endCommand();
      cancelCurrent = null;
      setFieldStatus(dot, text, 'error', 'Save failed');
      console.error(`send() threw for ${label}:`, err);
      onFailure?.();
    }
  }

  return {
    save,
    cleanup() {
      cancelCurrent?.();
    },
  };
}
