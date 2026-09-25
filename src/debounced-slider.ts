export interface DebouncedSliderOptions {
  /** Called on every `input` event before the debounce timer, for UI-only
   *  side-effects such as clamping the slider value or updating a visual
   *  track fill. Runs synchronously so any value clamping is visible to the
   *  subsequent `onSave` call. */
  onInput?: (slider: HTMLInputElement) => void;
  /** Called after the debounce delay (input path) or immediately on `change`
   *  when a timer is pending. Receives the slider's current numeric value,
   *  which reflects any clamping applied by `onInput`. */
  onSave: (value: number) => void | Promise<void>;
  delayMs?: number;
}

export interface BoundSlider {
  /** Cancels any pending timer and removes the event listeners. */
  cleanup: () => void;
  /** Returns true while a debounce timer is in-flight (i.e. the user has
   *  interacted with the slider but the save has not yet been dispatched).
   *  Use this to suppress poll-driven DOM updates during active editing. */
  hasPending: () => boolean;
}

/** Attaches debounced-save behaviour to a range input.
 *
 *  - `input` event  → run `onInput` side-effects, then reset the debounce timer.
 *  - `change` event → if a timer is pending, cancel it and save immediately;
 *                     if no timer is pending (debounce already fired), no-op.
 *
 *  Returns `{ cleanup, hasPending }`. Call `cleanup()` on disconnect to cancel
 *  any pending timer and detach the listeners. */
export function bindDebouncedSlider(
  slider: HTMLInputElement,
  opts: DebouncedSliderOptions
): BoundSlider {
  const delay = opts.delayMs ?? 500;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const fire = () => {
    timeout = null;
    void opts.onSave(parseInt(slider.value, 10));
  };

  const handleInput = () => {
    opts.onInput?.(slider);
    if (timeout !== null) clearTimeout(timeout);
    timeout = setTimeout(fire, delay);
  };

  const handleChange = () => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
      void opts.onSave(parseInt(slider.value, 10));
    }
  };

  slider.addEventListener('input', handleInput);
  slider.addEventListener('change', handleChange);

  return {
    cleanup: () => {
      if (timeout !== null) {
        clearTimeout(timeout);
        timeout = null;
      }
      slider.removeEventListener('input', handleInput);
      slider.removeEventListener('change', handleChange);
    },
    hasPending: () => timeout !== null,
  };
}
