// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bindDebouncedSlider } from '../debounced-slider';

function makeSlider(initialValue = '50') {
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '255';
  slider.value = initialValue;
  document.body.appendChild(slider);

  const fire = (event: string) => slider.dispatchEvent(new Event(event));

  return { slider, fire };
}

describe('bindDebouncedSlider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('does not call onSave immediately on input', () => {
    const { slider, fire } = makeSlider();
    const onSave = vi.fn().mockResolvedValue(undefined);
    bindDebouncedSlider(slider, { onSave, delayMs: 100 });
    fire('input');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('calls onSave with the parsed slider value after delayMs', async () => {
    const { slider, fire } = makeSlider('128');
    const onSave = vi.fn().mockResolvedValue(undefined);
    bindDebouncedSlider(slider, { onSave, delayMs: 100 });
    fire('input');
    await vi.advanceTimersByTimeAsync(100);
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith(128);
  });

  it('resets the timer on each input event (debounce)', async () => {
    const { slider, fire } = makeSlider();
    const onSave = vi.fn().mockResolvedValue(undefined);
    bindDebouncedSlider(slider, { onSave, delayMs: 100 });
    fire('input');
    await vi.advanceTimersByTimeAsync(50);
    fire('input');
    await vi.advanceTimersByTimeAsync(50);
    // Only 50ms have elapsed since the second input — timer still pending.
    expect(onSave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('on change fires onSave immediately when a timer is pending', async () => {
    const { slider, fire } = makeSlider('64');
    const onSave = vi.fn().mockResolvedValue(undefined);
    bindDebouncedSlider(slider, { onSave, delayMs: 100 });
    fire('input');
    fire('change');
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith(64);
    // Timer was cancelled — no second call after the delay.
    await vi.advanceTimersByTimeAsync(100);
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('on change does nothing when no timer is pending', () => {
    const { slider, fire } = makeSlider();
    const onSave = vi.fn().mockResolvedValue(undefined);
    bindDebouncedSlider(slider, { onSave, delayMs: 100 });
    fire('change'); // no prior input
    expect(onSave).not.toHaveBeenCalled();
  });

  it('calls onInput on every input event regardless of timer state', () => {
    const { slider, fire } = makeSlider();
    const onInput = vi.fn();
    const onSave = vi.fn().mockResolvedValue(undefined);
    bindDebouncedSlider(slider, { onInput, onSave, delayMs: 100 });
    fire('input');
    fire('input');
    fire('input');
    expect(onInput).toHaveBeenCalledTimes(3);
    expect(onInput).toHaveBeenCalledWith(slider);
  });

  it('onSave receives value after onInput has clamped it', async () => {
    const { slider, fire } = makeSlider('200');
    const onInput = vi.fn((s: HTMLInputElement) => {
      if (parseInt(s.value, 10) > 100) s.value = '100';
    });
    const onSave = vi.fn().mockResolvedValue(undefined);
    bindDebouncedSlider(slider, { onInput, onSave, delayMs: 100 });
    fire('input');
    await vi.advanceTimersByTimeAsync(100);
    expect(onSave).toHaveBeenCalledWith(100);
  });

  it('hasPending returns true while the debounce timer is running', () => {
    const { slider, fire } = makeSlider();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const bound = bindDebouncedSlider(slider, { onSave, delayMs: 100 });
    expect(bound.hasPending()).toBe(false);
    fire('input');
    expect(bound.hasPending()).toBe(true);
  });

  it('hasPending returns false after the timer fires', async () => {
    const { slider, fire } = makeSlider();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const bound = bindDebouncedSlider(slider, { onSave, delayMs: 100 });
    fire('input');
    await vi.advanceTimersByTimeAsync(100);
    expect(bound.hasPending()).toBe(false);
  });

  it('hasPending returns false after change flushes the timer', () => {
    const { slider, fire } = makeSlider();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const bound = bindDebouncedSlider(slider, { onSave, delayMs: 100 });
    fire('input');
    fire('change');
    expect(bound.hasPending()).toBe(false);
  });

  it('cleanup cancels a pending timer so onSave is never called', async () => {
    const { slider, fire } = makeSlider();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { cleanup } = bindDebouncedSlider(slider, { onSave, delayMs: 100 });
    fire('input');
    cleanup();
    await vi.advanceTimersByTimeAsync(100);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('cleanup removes listeners so subsequent input events are ignored', async () => {
    const { slider, fire } = makeSlider();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { cleanup } = bindDebouncedSlider(slider, { onSave, delayMs: 100 });
    cleanup();
    fire('input');
    await vi.advanceTimersByTimeAsync(100);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('cleanup removes listeners so subsequent change events are ignored', () => {
    const { slider, fire } = makeSlider();
    const onSave = vi.fn().mockResolvedValue(undefined);
    // Need a pending timer first so change would normally fire.
    const { cleanup } = bindDebouncedSlider(slider, { onSave, delayMs: 100 });
    fire('input');
    cleanup();
    fire('change');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('onSave receives the browser-clamped value when slider is set beyond max', async () => {
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = '200'; // jsdom clamps to max=100 on set
    document.body.appendChild(slider);

    const onSave = vi.fn().mockResolvedValue(undefined);
    bindDebouncedSlider(slider, { onSave, delayMs: 100 });
    slider.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(100);

    expect(onSave).toHaveBeenCalledWith(100);
  });

  it('hasPending returns false after cleanup', () => {
    const { slider, fire } = makeSlider();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const bound = bindDebouncedSlider(slider, { onSave, delayMs: 100 });
    fire('input');
    bound.cleanup();
    expect(bound.hasPending()).toBe(false);
  });

  it('uses the default 500ms delay when delayMs is not specified', async () => {
    const { slider, fire } = makeSlider('50');
    const onSave = vi.fn().mockResolvedValue(undefined);
    bindDebouncedSlider(slider, { onSave }); // no delayMs → default 500ms

    fire('input');

    // Should not fire before 500ms
    await vi.advanceTimersByTimeAsync(499);
    expect(onSave).not.toHaveBeenCalled();

    // Should fire at 500ms
    await vi.advanceTimersByTimeAsync(1);
    expect(onSave).toHaveBeenCalledOnce();
  });
});
