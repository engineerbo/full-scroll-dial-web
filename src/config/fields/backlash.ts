import {
  CONFIG_CMD,
  TLV_TYPE,
  GROUP,
  encodeTlv,
} from '../../../protocol/command';
import { CARD, checkPoll } from '../field-utils';
import type { FieldBinding, FieldContext } from '../field-utils';
import { bindDebouncedSlider } from '../../debounced-slider';
import { setFieldStatus } from '../../field-status';
import { makeSaver } from '../../save-command';
import { SENSITIVITY_DEBOUNCE_MS } from '../../constants';
import type { BoundSlider } from '../../debounced-slider';

/** Firmware stores the backlash in tenths of a degree. */
const TENTHS_PER_DEGREE = 10;

function formatBacklash(tenths: number): string {
  return tenths === 0 ? 'Off' : `${(tenths / TENTHS_PER_DEGREE).toFixed(1)}°`;
}

export const backlashHtml = `
<div id="backlashSection" class="${CARD}">
  <div class="flex items-center justify-between">
    <span class="text-sm font-medium text-neutral-700 dark:text-neutral-300">Backlash</span>
    <div class="flex items-center gap-1.5">
      <span id="backlashStatus" class="status-indicator status-idle" aria-label="Backlash status"></span>
      <span id="backlashStatusText" class="text-xs text-neutral-400 dark:text-neutral-500"></span>
    </div>
  </div>
  <p class="text-xs text-neutral-500 dark:text-neutral-400">
    Travel needed before scrolling resumes after a change of direction.
  </p>
  <div class="flex items-center gap-3">
    <label class="sr-only" for="backlashSlider">Backlash</label>
    <input type="range" id="backlashSlider" min="0" max="255" value="0" class="flex-1 accent-blue-600" />
    <span id="backlashValue" class="w-10 text-right text-sm tabular-nums text-neutral-600 dark:text-neutral-400">Off</span>
  </div>
</div>`;

export function bindBacklashField(ctx: FieldContext): FieldBinding {
  const { container, conn, getPoller, pollLastSeen } = ctx;
  const q = <T extends Element>(id: string): T =>
    container.querySelector(`#${id}`) as T;

  const section = q<HTMLDivElement>('backlashSection');
  const slider = q<HTMLInputElement>('backlashSlider');
  const valueLabel = q<HTMLSpanElement>('backlashValue');
  const dot = q<HTMLSpanElement>('backlashStatus');
  const statusText = q<HTMLSpanElement>('backlashStatusText');

  let lastGood: number | null = null;
  let bound: BoundSlider | null = null;

  const pollKey = `${GROUP.CONFIG}-${CONFIG_CMD.GET_BACKLASH}`;

  const { save, cleanup: cancelSave } = makeSaver(
    getPoller,
    () => conn.protocol,
    GROUP.CONFIG,
    CONFIG_CMD.SET_BACKLASH,
    dot,
    statusText,
    'backlash'
  );

  function saveBacklash(value: number): void {
    const min = parseInt(slider.min, 10);
    const max = parseInt(slider.max, 10);
    if (isNaN(value) || value < min || value > max) return;
    save(
      encodeTlv(TLV_TYPE.BACKLASH, new Uint8Array([value])),
      () => {
        valueLabel.textContent = formatBacklash(value);
        lastGood = value;
        pollLastSeen.set(pollKey, value);
      },
      () => {
        if (lastGood !== null) {
          slider.value = lastGood.toString();
          valueLabel.textContent = formatBacklash(lastGood);
        }
      }
    );
  }

  return {
    activate() {
      bound?.cleanup();
      lastGood = parseInt(slider.value, 10);

      bound = bindDebouncedSlider(slider, {
        onInput: (s) => {
          valueLabel.textContent = formatBacklash(parseInt(s.value, 10));
        },
        onSave: (v) => saveBacklash(v),
        delayMs: SENSITIVITY_DEBOUNCE_MS,
      });

      const onValue = (() => {
        let loaded = false;
        return (v: number) => {
          // Do not fight the user while a save is still pending
          if (bound?.hasPending()) return;
          slider.value = v.toString();
          valueLabel.textContent = formatBacklash(v);
          lastGood = v;
          section.classList.remove('hidden');
          if (loaded) {
            setFieldStatus(dot, statusText, 'success', 'Updated', true);
          }
          loaded = true;
        };
      })();

      return (entries) => checkPoll(entries, pollKey, 0, pollLastSeen, onValue);
    },

    cleanup() {
      cancelSave();
      bound?.cleanup();
      bound = null;
      lastGood = null;
      section.classList.add('hidden');
    },
  };
}
