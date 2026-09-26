import { GROUP, CORE_CMD } from '../../../protocol/command';
import { CARD } from '../field-utils';
import { BTN_DANGER, BTN_SECONDARY } from '../../button-classes';
import { setFieldStatus } from '../../field-status';
import { makeRunner } from '../../run-command';
import type { FieldBinding, FieldContext } from '../field-utils';

/** How long the button stays armed waiting for the confirming second click. */
export const RESET_CONFIRM_MS = 4000;

const IDLE_LABEL = 'Restore defaults';
const ARMED_LABEL = 'Confirm restore defaults';
const IDLE_MESSAGE = 'Restores all settings to their default values.';

export const resetDefaultsHtml = `
<div id="resetDefaultsSection" class="${CARD}">
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-1.5">
      <span class="text-sm font-medium text-neutral-700 dark:text-neutral-300">Restore defaults</span>
    </div>
    <div class="flex items-center gap-1.5">
      <span id="resetDefaultsStatus" class="status-indicator status-idle" aria-label="Restore defaults status"></span>
      <span id="resetDefaultsStatusText" class="text-xs text-neutral-400 dark:text-neutral-500"></span>
    </div>
  </div>
  <p id="resetDefaultsMessage" class="text-xs text-neutral-500 dark:text-neutral-400">
    ${IDLE_MESSAGE}
  </p>
  <button id="resetDefaultsBtn" class="${BTN_SECONDARY}">${IDLE_LABEL}</button>
</div>`;

export function bindResetDefaultsField(ctx: FieldContext): FieldBinding {
  const { container, conn, getPoller } = ctx;
  const q = <T extends Element>(id: string): T =>
    container.querySelector(`#${id}`) as T;

  const section = q<HTMLDivElement>('resetDefaultsSection');
  const dot = q<HTMLSpanElement>('resetDefaultsStatus');
  const statusText = q<HTMLSpanElement>('resetDefaultsStatusText');
  const message = q<HTMLParagraphElement>('resetDefaultsMessage');
  const btn = q<HTMLButtonElement>('resetDefaultsBtn');

  // Firmware saves ~8 settings to flash before replying; makeRunner's 2 s timeout
  // covers that, where makeSaver's 1 s default would not
  const { run, cleanup: cancelRun } = makeRunner(
    getPoller,
    () => conn.protocol,
    GROUP.CORE,
    CORE_CMD.RESET_DEFAULTS,
    'reset defaults'
  );

  let armTimer: ReturnType<typeof setTimeout> | null = null;

  function disarm(): void {
    if (armTimer !== null) clearTimeout(armTimer);
    armTimer = null;
    btn.className = BTN_SECONDARY;
    btn.textContent = IDLE_LABEL;
  }

  function fail(text: string): void {
    btn.disabled = false;
    setFieldStatus(dot, statusText, 'error', 'Failed');
    message.textContent = text;
  }

  btn.addEventListener('click', () => {
    if (armTimer === null) {
      btn.className = BTN_DANGER;
      btn.textContent = ARMED_LABEL;
      armTimer = setTimeout(disarm, RESET_CONFIRM_MS);
      return;
    }

    disarm();
    btn.disabled = true;
    setFieldStatus(dot, statusText, 'loading', 'Restoring…');

    // The other cards pick up the new values from the next poll
    const started = run((outcome) => {
      if (!outcome.ok) {
        fail(
          outcome.reason === 'timeout'
            ? 'The device did not respond.'
            : 'Could not restore defaults.'
        );
        return;
      }
      btn.disabled = false;
      setFieldStatus(dot, statusText, 'success', 'Restored', true);
      message.textContent = 'Settings restored to factory defaults.';
    });

    if (!started) fail('Not connected.');
  });

  return {
    activate() {
      // Nothing to poll, so reveal the card here (see self-test.ts)
      section.classList.remove('hidden');
      return () => {};
    },

    cleanup() {
      cancelRun();
      disarm();
      section.classList.add('hidden');
      btn.disabled = false;
      dot.className = 'status-indicator status-idle';
      statusText.textContent = '';
      message.textContent = IDLE_MESSAGE;
    },
  };
}
