import {
  GROUP,
  CONFIG_CMD,
  TLV_TYPE,
  encodeTlv,
} from '../../../protocol/command';
import { applyRangeTrackFill, thumbOffsetCss } from '../../range-track';
import { bindDebouncedSlider } from '../../debounced-slider';
import { setFieldStatus } from '../../field-status';
import { makeSaver } from '../../save-command';
import { SENSITIVITY_DEBOUNCE_MS, THUMB_RADIUS_PX } from '../../constants';
import { checkPoll, CARD } from '../field-utils';
import type { FieldBinding, FieldContext } from '../field-utils';

export const sensitivityHtml = `
<div id="sensitivitySection" class="${CARD}">
  <div class="flex items-center justify-between">
    <span class="text-sm font-medium text-neutral-700 dark:text-neutral-300">Sensitivity</span>
    <div class="flex items-center gap-1.5">
      <span id="sensitivityStatus" class="status-indicator status-idle" aria-label="Sensitivity status"></span>
      <span id="sensitivityStatusText" class="text-xs text-neutral-400 dark:text-neutral-500"></span>
    </div>
  </div>
  <div class="flex items-center gap-3">
    <label class="sr-only" for="sensitivitySlider">Sensitivity</label>
    <input type="range" id="sensitivitySlider" min="1" max="255" value="1" class="flex-1 accent-blue-600" />
    <span id="sensitivityValue" class="w-8 text-right text-sm tabular-nums text-neutral-600 dark:text-neutral-400">1</span>
  </div>
</div>
<div id="sensitivityRangeSection" class="${CARD}">
  <div class="flex items-center justify-between">
    <span class="text-sm font-medium text-neutral-700 dark:text-neutral-300">Sensitivity range</span>
    <div class="flex items-center gap-1.5">
      <span id="sensitivityRangeStatus" class="status-indicator status-idle" aria-label="Sensitivity range status"></span>
      <span id="sensitivityRangeStatusText" class="text-xs text-neutral-400 dark:text-neutral-500"></span>
    </div>
  </div>
  <div class="relative pt-5">
    <span id="minSensitivityLabel" class="range-value-label">1</span>
    <span id="maxSensitivityLabel" class="range-value-label">255</span>
    <div class="dual-range-container" id="sensitivityRangeTrack">
      <div class="dual-range-fill"></div>
      <label class="sr-only" for="minSensitivityRange">Min sensitivity</label>
      <input type="range" id="minSensitivityRange" min="1" max="255" value="1" class="dual-range" />
      <label class="sr-only" for="maxSensitivityRange">Max sensitivity</label>
      <input type="range" id="maxSensitivityRange" min="1" max="255" value="255" class="dual-range" />
    </div>
  </div>
</div>`;

export function bindSensitivityFields(ctx: FieldContext): FieldBinding {
  const { container, conn, getPoller, pollLastSeen } = ctx;
  const q = <T extends Element>(id: string): T =>
    container.querySelector(`#${id}`) as T;

  const sensitivitySection = q<HTMLDivElement>('sensitivitySection');
  const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
  const sensitivityValue = q<HTMLSpanElement>('sensitivityValue');
  const sensitivityStatus = q<HTMLSpanElement>('sensitivityStatus');
  const sensitivityStatusText = q<HTMLSpanElement>('sensitivityStatusText');
  const sensitivityRangeSection = q<HTMLDivElement>('sensitivityRangeSection');
  const sensitivityRangeTrack = q<HTMLDivElement>('sensitivityRangeTrack');
  const minSensitivityRange = q<HTMLInputElement>('minSensitivityRange');
  const maxSensitivityRange = q<HTMLInputElement>('maxSensitivityRange');
  const minSensitivityLabel = q<HTMLSpanElement>('minSensitivityLabel');
  const maxSensitivityLabel = q<HTMLSpanElement>('maxSensitivityLabel');
  const sensitivityRangeStatus = q<HTMLSpanElement>('sensitivityRangeStatus');
  const sensitivityRangeStatusText = q<HTMLSpanElement>(
    'sensitivityRangeStatusText'
  );

  let lastGoodSensitivity: number | null = null;
  let lastGoodMinSensitivity: number | null = null;
  let lastGoodMaxSensitivity: number | null = null;
  let cleanupSliders: (() => void) | null = null;

  const sensitivityKey = `${GROUP.CONFIG}-${CONFIG_CMD.GET_SENSITIVITY}`;
  const minKey = `${GROUP.CONFIG}-${CONFIG_CMD.GET_MIN_SENSITIVITY}`;
  const maxKey = `${GROUP.CONFIG}-${CONFIG_CMD.GET_MAX_SENSITIVITY}`;

  const { save: sendSensitivity, cleanup: cancelSensitivity } = makeSaver(
    getPoller,
    () => conn.protocol,
    GROUP.CONFIG,
    CONFIG_CMD.SET_SENSITIVITY,
    sensitivityStatus,
    sensitivityStatusText,
    'sensitivity'
  );
  const { save: sendMinSensitivity, cleanup: cancelMinSensitivity } = makeSaver(
    getPoller,
    () => conn.protocol,
    GROUP.CONFIG,
    CONFIG_CMD.SET_MIN_SENSITIVITY,
    sensitivityRangeStatus,
    sensitivityRangeStatusText,
    'min sensitivity'
  );
  const { save: sendMaxSensitivity, cleanup: cancelMaxSensitivity } = makeSaver(
    getPoller,
    () => conn.protocol,
    GROUP.CONFIG,
    CONFIG_CMD.SET_MAX_SENSITIVITY,
    sensitivityRangeStatus,
    sensitivityRangeStatusText,
    'max sensitivity'
  );

  function updateRangeTrackFill(): void {
    const absMin = parseInt(minSensitivityRange.min, 10);
    const absMax = parseInt(minSensitivityRange.max, 10);
    const { minPct, maxPct } = applyRangeTrackFill(
      sensitivityRangeTrack,
      parseInt(minSensitivityRange.value, 10),
      parseInt(maxSensitivityRange.value, 10),
      absMin,
      absMax
    );
    minSensitivityLabel.textContent = minSensitivityRange.value;
    maxSensitivityLabel.textContent = maxSensitivityRange.value;
    minSensitivityLabel.style.left = thumbOffsetCss(minPct, THUMB_RADIUS_PX);
    maxSensitivityLabel.style.left = thumbOffsetCss(maxPct, THUMB_RADIUS_PX);
  }

  function saveSensitivity(sensitivity: number): void {
    const min = parseInt(sensitivitySlider.min, 10);
    const max = parseInt(sensitivitySlider.max, 10);
    if (isNaN(sensitivity) || sensitivity < min || sensitivity > max) return;
    sendSensitivity(
      encodeTlv(TLV_TYPE.SENSITIVITY, new Uint8Array([sensitivity])),
      () => {
        sensitivityValue.textContent = sensitivity.toString();
        lastGoodSensitivity = sensitivity;
        pollLastSeen.set(sensitivityKey, sensitivity);
      },
      () => {
        if (lastGoodSensitivity !== null) {
          sensitivitySlider.value = lastGoodSensitivity.toString();
          sensitivityValue.textContent = lastGoodSensitivity.toString();
        }
      }
    );
  }

  function saveMinSensitivity(v: number): void {
    const max = parseInt(maxSensitivityRange.value, 10);
    const rollbackMin = () => {
      if (lastGoodMinSensitivity !== null) {
        minSensitivityRange.value = lastGoodMinSensitivity.toString();
        updateRangeTrackFill();
      }
    };
    if (isNaN(v) || isNaN(max) || v < 1 || v >= max) {
      rollbackMin();
      setFieldStatus(
        sensitivityRangeStatus,
        sensitivityRangeStatusText,
        'error',
        'Min must be less than max'
      );
      return;
    }
    if (lastGoodSensitivity !== null && v > lastGoodSensitivity) {
      rollbackMin();
      setFieldStatus(
        sensitivityRangeStatus,
        sensitivityRangeStatusText,
        'error',
        'Min cannot exceed current sensitivity'
      );
      return;
    }
    sendMinSensitivity(
      encodeTlv(TLV_TYPE.MIN_SENSITIVITY, new Uint8Array([v])),
      () => {
        lastGoodMinSensitivity = v;
        sensitivitySlider.min = v.toString();
        pollLastSeen.set(minKey, v);
      },
      rollbackMin
    );
  }

  function saveMaxSensitivity(v: number): void {
    const min = parseInt(minSensitivityRange.value, 10);
    const rollbackMax = () => {
      if (lastGoodMaxSensitivity !== null) {
        maxSensitivityRange.value = lastGoodMaxSensitivity.toString();
        updateRangeTrackFill();
      }
    };
    if (isNaN(v) || isNaN(min) || v <= min || v > 255) {
      rollbackMax();
      setFieldStatus(
        sensitivityRangeStatus,
        sensitivityRangeStatusText,
        'error',
        'Max must be greater than min'
      );
      return;
    }
    if (lastGoodSensitivity !== null && v < lastGoodSensitivity) {
      rollbackMax();
      setFieldStatus(
        sensitivityRangeStatus,
        sensitivityRangeStatusText,
        'error',
        'Max cannot be below current sensitivity'
      );
      return;
    }
    sendMaxSensitivity(
      encodeTlv(TLV_TYPE.MAX_SENSITIVITY, new Uint8Array([v])),
      () => {
        lastGoodMaxSensitivity = v;
        sensitivitySlider.max = v.toString();
        pollLastSeen.set(maxKey, v);
      },
      rollbackMax
    );
  }

  return {
    activate() {
      // Tear down previous slider bindings before rebinding
      cleanupSliders?.();

      // Seed from the slider's current DOM value so cross-field constraints
      // work correctly in the window between activate() and the first poll.
      const seededSensitivity = parseInt(sensitivitySlider.value, 10);
      if (!isNaN(seededSensitivity)) lastGoodSensitivity = seededSensitivity;

      const sensitivitySliderBound = bindDebouncedSlider(sensitivitySlider, {
        onInput: (slider) => {
          sensitivityValue.textContent = slider.value;
        },
        onSave: (v) => saveSensitivity(v),
        delayMs: SENSITIVITY_DEBOUNCE_MS,
      });

      const minSensitivityBound = bindDebouncedSlider(minSensitivityRange, {
        onInput: (slider) => {
          const v = parseInt(slider.value, 10);
          const max = parseInt(maxSensitivityRange.value, 10);
          const minCeiling =
            lastGoodSensitivity !== null
              ? Math.min(max - 1, lastGoodSensitivity)
              : max - 1;
          if (v > minCeiling) slider.value = minCeiling.toString();
          updateRangeTrackFill();
        },
        onSave: (v) => saveMinSensitivity(v),
        delayMs: SENSITIVITY_DEBOUNCE_MS,
      });

      const maxSensitivityBound = bindDebouncedSlider(maxSensitivityRange, {
        onInput: (slider) => {
          const v = parseInt(slider.value, 10);
          const min = parseInt(minSensitivityRange.value, 10);
          const maxFloor =
            lastGoodSensitivity !== null
              ? Math.max(min + 1, lastGoodSensitivity)
              : min + 1;
          if (v < maxFloor) slider.value = maxFloor.toString();
          updateRangeTrackFill();
        },
        onSave: (v) => saveMaxSensitivity(v),
        delayMs: SENSITIVITY_DEBOUNCE_MS,
      });

      cleanupSliders = () => {
        sensitivitySliderBound.cleanup();
        minSensitivityBound.cleanup();
        maxSensitivityBound.cleanup();
      };

      // Poll callbacks: fresh `loaded` flag + capture new slider bindings
      const onSensitivityValue = (() => {
        let loaded = false;
        return (v: number) => {
          if (sensitivitySliderBound.hasPending()) return;
          sensitivitySlider.value = v.toString();
          sensitivityValue.textContent = v.toString();
          lastGoodSensitivity = v;
          sensitivitySection.classList.remove('hidden');
          if (loaded)
            setFieldStatus(
              sensitivityStatus,
              sensitivityStatusText,
              'success',
              'Updated',
              true
            );
          loaded = true;
        };
      })();

      const onMinSensitivityValue = (() => {
        let loaded = false;
        return (v: number) => {
          if (minSensitivityBound.hasPending()) return;
          minSensitivityRange.value = v.toString();
          const fromDevice = loaded && v !== lastGoodMinSensitivity;
          lastGoodMinSensitivity = v;
          sensitivitySlider.min = v.toString();
          sensitivityRangeSection.classList.remove('hidden');
          updateRangeTrackFill();
          if (fromDevice)
            setFieldStatus(
              sensitivityRangeStatus,
              sensitivityRangeStatusText,
              'success',
              'Updated',
              true
            );
          loaded = true;
        };
      })();

      const onMaxSensitivityValue = (() => {
        let loaded = false;
        return (v: number) => {
          if (maxSensitivityBound.hasPending()) return;
          maxSensitivityRange.value = v.toString();
          const fromDevice = loaded && v !== lastGoodMaxSensitivity;
          lastGoodMaxSensitivity = v;
          sensitivitySlider.max = v.toString();
          sensitivityRangeSection.classList.remove('hidden');
          updateRangeTrackFill();
          if (fromDevice)
            setFieldStatus(
              sensitivityRangeStatus,
              sensitivityRangeStatusText,
              'success',
              'Updated',
              true
            );
          loaded = true;
        };
      })();

      return (entries) => {
        checkPoll(entries, sensitivityKey, 1, pollLastSeen, onSensitivityValue);
        checkPoll(entries, minKey, 1, pollLastSeen, onMinSensitivityValue);
        checkPoll(entries, maxKey, 255, pollLastSeen, onMaxSensitivityValue);
      };
    },

    cleanup() {
      cancelSensitivity();
      cancelMinSensitivity();
      cancelMaxSensitivity();
      cleanupSliders?.();
      cleanupSliders = null;
      lastGoodSensitivity = null;
      lastGoodMinSensitivity = null;
      lastGoodMaxSensitivity = null;
      sensitivitySection.classList.add('hidden');
      sensitivityRangeSection.classList.add('hidden');
    },
  };
}
