import {
  GROUP,
  CORE_CMD,
  TLV_TYPE,
  SELFTEST_RESULT,
  decodeTlv,
  selfTestMessage,
  parseSelfTestDiagnostics,
  describeSelfTestStatus,
  SELFTEST_AGC_FULL_SCALE,
} from '../../../protocol/command';
import { CARD } from '../field-utils';
import { BTN_CONNECT } from '../../button-classes';
import { setFieldStatus } from '../../field-status';
import { makeRunner } from '../../run-command';
import type { FieldBinding, FieldContext } from '../field-utils';

const IDLE_MESSAGE =
  'Checks the rotation sensor and the magnet inside the dial.';

export const selfTestHtml = `
<div id="selfTestSection" class="${CARD}">
  <div class="flex items-center justify-between">
    <span class="text-sm font-medium text-neutral-700 dark:text-neutral-300">Self-test</span>
    <div class="flex items-center gap-1.5">
      <span id="selfTestStatus" class="status-indicator status-idle" aria-label="Self-test status"></span>
      <span id="selfTestStatusText" class="text-xs text-neutral-400 dark:text-neutral-500"></span>
    </div>
  </div>
  <p id="selfTestMessage" class="text-xs text-neutral-500 dark:text-neutral-400">
    ${IDLE_MESSAGE}
  </p>
  <dl id="selfTestDiagnostics" class="hidden space-y-1.5">
    <div class="flex items-center justify-between">
      <dt class="text-xs text-neutral-500 dark:text-neutral-400">Sensor gain (lower = magnet closer)</dt>
      <dd id="selfTestAgc" class="text-xs font-mono text-neutral-700 dark:text-neutral-300"></dd>
    </div>
    <div class="flex items-center justify-between">
      <dt class="text-xs text-neutral-500 dark:text-neutral-400">Signal magnitude</dt>
      <dd id="selfTestMagnitude" class="text-xs font-mono text-neutral-700 dark:text-neutral-300"></dd>
    </div>
    <div class="flex items-center justify-between">
      <dt class="text-xs text-neutral-500 dark:text-neutral-400">Magnet detection</dt>
      <dd id="selfTestStatusReg" class="text-xs font-mono text-neutral-700 dark:text-neutral-300"></dd>
    </div>
  </dl>
  <button id="selfTestRunBtn" class="${BTN_CONNECT}">Run self-test</button>
</div>`;

export function bindSelfTestField(ctx: FieldContext): FieldBinding {
  const { container, conn, getPoller } = ctx;
  const q = <T extends Element>(id: string): T =>
    container.querySelector(`#${id}`) as T;

  const section = q<HTMLDivElement>('selfTestSection');
  const dot = q<HTMLSpanElement>('selfTestStatus');
  const statusText = q<HTMLSpanElement>('selfTestStatusText');
  const message = q<HTMLParagraphElement>('selfTestMessage');
  const diagnostics = q<HTMLDListElement>('selfTestDiagnostics');
  const agcValue = q<HTMLElement>('selfTestAgc');
  const magnitudeValue = q<HTMLElement>('selfTestMagnitude');
  const statusRegValue = q<HTMLElement>('selfTestStatusReg');
  const runBtn = q<HTMLButtonElement>('selfTestRunBtn');

  const { run, cleanup: cancelRun } = makeRunner(
    getPoller,
    () => conn.protocol,
    GROUP.CORE,
    CORE_CMD.RUN_SELFTEST,
    'self-test'
  );

  function showDiagnostics(data: Uint8Array): void {
    const entry = decodeTlv(data).get(TLV_TYPE.SELFTEST_ENCODER);
    // Absent whenever the test stopped before reaching the sensor registers
    const parsed = entry ? parseSelfTestDiagnostics(entry) : null;
    if (!parsed) {
      diagnostics.classList.add('hidden');
      return;
    }
    agcValue.textContent = `${parsed.agc} / ${SELFTEST_AGC_FULL_SCALE}`;
    magnitudeValue.textContent = `${parsed.magnitude}`;
    // Raw byte kept too: reserved bits vary between parts
    statusRegValue.textContent =
      describeSelfTestStatus(parsed.status) +
      ' (0x' +
      parsed.status.toString(16).padStart(2, '0').toUpperCase() +
      ')';
    diagnostics.classList.remove('hidden');
  }

  runBtn.addEventListener('click', () => {
    runBtn.disabled = true;
    diagnostics.classList.add('hidden');
    setFieldStatus(dot, statusText, 'loading', 'Running…');
    message.textContent = 'Testing…';

    const started = run((outcome) => {
      runBtn.disabled = false;

      if (!outcome.ok) {
        setFieldStatus(dot, statusText, 'error', 'Failed');
        message.textContent =
          outcome.reason === 'timeout'
            ? 'The device did not respond.'
            : 'Could not run the self-test.';
        return;
      }

      const resultEntry = decodeTlv(outcome.data).get(TLV_TYPE.SELFTEST_RESULT);
      const code = resultEntry?.[0];
      if (code === undefined) {
        setFieldStatus(dot, statusText, 'error', 'Failed');
        message.textContent = 'The device sent an unreadable result.';
        return;
      }

      const passed = code === SELFTEST_RESULT.OK;
      setFieldStatus(
        dot,
        statusText,
        passed ? 'success' : 'error',
        passed ? 'Passed' : 'Failed'
      );
      // Several codes share a message, so show the raw one for diagnosis
      message.textContent = passed
        ? selfTestMessage(code)
        : `${selfTestMessage(code)} (code ${code})`;
      showDiagnostics(outcome.data);
    });

    if (!started) {
      runBtn.disabled = false;
      setFieldStatus(dot, statusText, 'error', 'Failed');
      message.textContent = 'Not connected.';
    }
  });

  return {
    activate() {
      // Nothing to poll, so reveal the card here — every other card un-hides from
      // its first poll callback via makeFieldCallback
      section.classList.remove('hidden');
      return () => {};
    },

    cleanup() {
      cancelRun();
      section.classList.add('hidden');
      diagnostics.classList.add('hidden');
      runBtn.disabled = false;
      dot.className = 'status-indicator status-idle';
      statusText.textContent = '';
      message.textContent = IDLE_MESSAGE;
    },
  };
}
