// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GROUP, CONFIG_CMD, RESPONSE_STATUS } from '../../protocol/command';
import {
  sensitivityHtml,
  bindSensitivityFields,
} from '../config/fields/sensitivity';
import type { FieldContext } from '../config/field-utils';
import type { ConnectionManager } from '../connection';
import type { Poller } from '../poller';
import { SENSITIVITY_DEBOUNCE_MS } from '../constants';

const SENS_KEY = `${GROUP.CONFIG}-${CONFIG_CMD.GET_SENSITIVITY}`;
const MIN_KEY = `${GROUP.CONFIG}-${CONFIG_CMD.GET_MIN_SENSITIVITY}`;
const MAX_KEY = `${GROUP.CONFIG}-${CONFIG_CMD.GET_MAX_SENSITIVITY}`;

function entries(
  vals: Partial<Record<string, number>>
): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(vals)) {
    if (v !== undefined) m.set(k, new Uint8Array([v]));
  }
  return m;
}

type ResponseHandler = (g: number, c: number, s: number, d: Uint8Array) => void;

function makeMockProtocol() {
  const handlers: ResponseHandler[] = [];
  const send = vi.fn();
  const on = vi
    .fn()
    .mockImplementation((_e: string, h: ResponseHandler) => handlers.push(h));
  const off = vi.fn().mockImplementation((_e: string, h: ResponseHandler) => {
    const idx = handlers.indexOf(h);
    if (idx !== -1) handlers.splice(idx, 1);
  });
  function simulateResponse(
    g: number,
    c: number,
    s: number,
    d: Uint8Array = new Uint8Array()
  ) {
    for (const h of [...handlers]) h(g, c, s, d);
  }
  return { send, on, off, simulateResponse };
}

function makeSetup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  container.innerHTML = sensitivityHtml;

  const protocol = makeMockProtocol();
  const conn = {
    protocol,
  } as unknown as ConnectionManager;

  const poller = {
    beginCommand: vi.fn(),
    endCommand: vi.fn(),
  } as unknown as Poller;

  const pollLastSeen = new Map<string, number>();

  const ctx: FieldContext = {
    container,
    conn,
    getPoller: () => poller,
    pollLastSeen,
  };

  const binding = bindSensitivityFields(ctx);

  function q<T extends Element>(id: string): T {
    return container.querySelector(`#${id}`) as T;
  }

  return { binding, container, protocol, conn, pollLastSeen, poller, q };
}

// ── Seeding ───────────────────────────────────────────────────────────────────

describe('activate() seeding', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('seeds lastGoodSensitivity from slider DOM value, clamping min-slider correctly', () => {
    const { binding, q } = makeSetup();
    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    const minSensitivityRange = q<HTMLInputElement>('minSensitivityRange');
    const maxSensitivityRange = q<HTMLInputElement>('maxSensitivityRange');

    sensitivitySlider.value = '50';
    maxSensitivityRange.value = '200';

    binding.activate();

    minSensitivityRange.value = '80';
    minSensitivityRange.dispatchEvent(new Event('input'));

    expect(minSensitivityRange.value).toBe('50');
  });

  it('uses the HTML default (1) as the seed when slider value is the default', () => {
    const { binding, q } = makeSetup();
    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    const minSensitivityRange = q<HTMLInputElement>('minSensitivityRange');
    const maxSensitivityRange = q<HTMLInputElement>('maxSensitivityRange');

    expect(sensitivitySlider.value).toBe('1');
    maxSensitivityRange.value = '200';
    binding.activate();

    // Min ceiling = min(199, 1) = 1; any value > 1 is clamped to 1
    minSensitivityRange.value = '50';
    minSensitivityRange.dispatchEvent(new Event('input'));
    expect(minSensitivityRange.value).toBe('1');
  });

  it('activate() on reconnect tears down old bindings before creating new ones', async () => {
    const { binding, protocol, q } = makeSetup();
    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    sensitivitySlider.value = '128';

    binding.activate();
    binding.activate(); // second activation should tear down first

    sensitivitySlider.value = '100';
    sensitivitySlider.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    // Only one save should fire, not two (old listener was removed)
    expect(protocol.send).toHaveBeenCalledTimes(1);
  });
});

// ── Main sensitivity slider ───────────────────────────────────────────────────

describe('sensitivitySlider save', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('calls protocol.send after the debounce delay', async () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const slider = q<HTMLInputElement>('sensitivitySlider');
    slider.value = '100';
    slider.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    expect(protocol.send).toHaveBeenCalledTimes(1);
  });

  it('shows "Saved" status after a successful save', async () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const slider = q<HTMLInputElement>('sensitivitySlider');
    const statusText = q<HTMLSpanElement>('sensitivityStatusText');
    slider.value = '100';
    slider.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_SENSITIVITY,
      RESPONSE_STATUS.SUCCESS
    );

    expect(statusText.textContent).toBe('Saved');
  });

  it('reverts slider and display to lastGoodSensitivity on error response', async () => {
    const { binding, protocol, q } = makeSetup();
    const pollHandler = binding.activate();

    // Establish a known good value via the first poll
    pollHandler(entries({ [SENS_KEY]: 60 }));

    const slider = q<HTMLInputElement>('sensitivitySlider');
    const valueDisplay = q<HTMLSpanElement>('sensitivityValue');
    slider.value = '200';
    slider.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_SENSITIVITY,
      RESPONSE_STATUS.ERROR
    );

    expect(slider.value).toBe('60');
    expect(valueDisplay.textContent).toBe('60');
  });

  it('shows "Save failed" status when error response arrives', async () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const slider = q<HTMLInputElement>('sensitivitySlider');
    slider.value = '50';
    slider.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_SENSITIVITY,
      RESPONSE_STATUS.ERROR
    );

    expect(q<HTMLSpanElement>('sensitivityStatusText').textContent).toBe(
      'Save failed'
    );
  });

  it('shows "Save failed" status on timeout', async () => {
    const { binding, q } = makeSetup();
    binding.activate();

    const slider = q<HTMLInputElement>('sensitivitySlider');
    slider.value = '50';
    slider.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    // Advance past the 1000ms makeSaver timeout
    vi.advanceTimersByTime(1000);

    expect(q<HTMLSpanElement>('sensitivityStatusText').textContent).toBe(
      'Save failed'
    );
  });
});

// ── Poll handler for main sensitivity ─────────────────────────────────────────

describe('sensitivity poll callbacks', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('first poll reveals sensitivitySection', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();

    expect(q('sensitivitySection').classList.contains('hidden')).toBe(true);
    pollHandler(entries({ [SENS_KEY]: 80 }));
    expect(q('sensitivitySection').classList.contains('hidden')).toBe(false);
  });

  it('first poll does NOT show "Updated"', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(entries({ [SENS_KEY]: 80 }));
    expect(q<HTMLSpanElement>('sensitivityStatusText').textContent).toBe('');
  });

  it('second poll with a different value shows "Updated"', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(entries({ [SENS_KEY]: 80 }));
    pollHandler(entries({ [SENS_KEY]: 90 }));
    expect(q<HTMLSpanElement>('sensitivityStatusText').textContent).toBe(
      'Updated'
    );
  });

  it('second poll with the same value does NOT show "Updated"', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(entries({ [SENS_KEY]: 80 }));
    pollHandler(entries({ [SENS_KEY]: 80 }));
    expect(q<HTMLSpanElement>('sensitivityStatusText').textContent).toBe('');
  });

  it('poll update is suppressed when sensitivity slider has a pending debounce', async () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();

    pollHandler(entries({ [SENS_KEY]: 50 }));

    const slider = q<HTMLInputElement>('sensitivitySlider');
    slider.value = '100';
    slider.dispatchEvent(new Event('input')); // debounce now pending

    pollHandler(entries({ [SENS_KEY]: 30 }));

    expect(slider.value).toBe('100');
  });
});

// ── Min sensitivity slider ────────────────────────────────────────────────────

describe('saveMinSensitivity', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('valid save updates sensitivitySlider.min and pollLastSeen', async () => {
    const { binding, protocol, q, pollLastSeen } = makeSetup();
    binding.activate();

    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    sensitivitySlider.value = '100';
    binding.activate(); // re-activate to pick up seed

    const maxSensitivityRange = q<HTMLInputElement>('maxSensitivityRange');
    const minSensitivityRange = q<HTMLInputElement>('minSensitivityRange');
    maxSensitivityRange.value = '200';
    minSensitivityRange.value = '40';
    minSensitivityRange.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_MIN_SENSITIVITY,
      RESPONSE_STATUS.SUCCESS
    );

    expect(sensitivitySlider.min).toBe('40');
    expect(pollLastSeen.get(MIN_KEY)).toBe(40);
  });

  it('failed save reverts minSensitivityRange to lastGoodMinSensitivity', async () => {
    const { binding, protocol, q } = makeSetup();
    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    sensitivitySlider.value = '200';
    binding.activate();

    const maxSensitivityRange = q<HTMLInputElement>('maxSensitivityRange');
    const minSensitivityRange = q<HTMLInputElement>('minSensitivityRange');
    maxSensitivityRange.value = '255';

    // First save succeeds → lastGoodMinSensitivity = 30
    minSensitivityRange.value = '30';
    minSensitivityRange.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);
    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_MIN_SENSITIVITY,
      RESPONSE_STATUS.SUCCESS
    );

    // Second save fails
    minSensitivityRange.value = '80';
    minSensitivityRange.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);
    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_MIN_SENSITIVITY,
      RESPONSE_STATUS.ERROR
    );

    expect(minSensitivityRange.value).toBe('30');
  });

  it('shows error when v >= max (race: max decreases between input and save)', async () => {
    const { binding, q } = makeSetup();
    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    sensitivitySlider.value = '250';
    binding.activate();

    const maxSensitivityRange = q<HTMLInputElement>('maxSensitivityRange');
    const minSensitivityRange = q<HTMLInputElement>('minSensitivityRange');
    maxSensitivityRange.value = '200';

    minSensitivityRange.value = '150';
    minSensitivityRange.dispatchEvent(new Event('input'));

    maxSensitivityRange.value = '100';

    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    expect(q<HTMLSpanElement>('sensitivityRangeStatusText').textContent).toBe(
      'Min must be less than max'
    );
  });

  it('shows error when v > lastGoodSensitivity (race: sensitivity decreases between input and save)', async () => {
    const { binding, q } = makeSetup();
    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    sensitivitySlider.value = '200';
    const pollHandler = binding.activate();

    pollHandler(entries({ [SENS_KEY]: 100 }));

    const maxSensitivityRange = q<HTMLInputElement>('maxSensitivityRange');
    const minSensitivityRange = q<HTMLInputElement>('minSensitivityRange');
    maxSensitivityRange.value = '255';

    minSensitivityRange.value = '80';
    minSensitivityRange.dispatchEvent(new Event('input'));

    pollHandler(entries({ [SENS_KEY]: 50 }));

    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    expect(q<HTMLSpanElement>('sensitivityRangeStatusText').textContent).toBe(
      'Min cannot exceed current sensitivity'
    );
  });
});

// ── Max sensitivity slider ────────────────────────────────────────────────────

describe('saveMaxSensitivity', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('valid save updates sensitivitySlider.max and pollLastSeen', async () => {
    const { binding, protocol, q, pollLastSeen } = makeSetup();
    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    sensitivitySlider.value = '50';
    binding.activate();

    const maxSensitivityRange = q<HTMLInputElement>('maxSensitivityRange');
    const minSensitivityRange = q<HTMLInputElement>('minSensitivityRange');
    minSensitivityRange.value = '1';
    maxSensitivityRange.value = '200';
    maxSensitivityRange.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_MAX_SENSITIVITY,
      RESPONSE_STATUS.SUCCESS
    );

    expect(sensitivitySlider.max).toBe('200');
    expect(pollLastSeen.get(MAX_KEY)).toBe(200);
  });

  it('failed save reverts maxSensitivityRange to lastGoodMaxSensitivity', async () => {
    const { binding, protocol, q } = makeSetup();
    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    sensitivitySlider.value = '1';
    binding.activate();

    const maxSensitivityRange = q<HTMLInputElement>('maxSensitivityRange');
    const minSensitivityRange = q<HTMLInputElement>('minSensitivityRange');
    minSensitivityRange.value = '1';

    // First save succeeds → lastGoodMaxSensitivity = 200
    maxSensitivityRange.value = '200';
    maxSensitivityRange.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);
    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_MAX_SENSITIVITY,
      RESPONSE_STATUS.SUCCESS
    );

    // Second save fails
    maxSensitivityRange.value = '150';
    maxSensitivityRange.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);
    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_MAX_SENSITIVITY,
      RESPONSE_STATUS.ERROR
    );

    expect(maxSensitivityRange.value).toBe('200');
  });

  it('shows error when v <= min (race: min increases between input and save)', async () => {
    const { binding, q } = makeSetup();
    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    sensitivitySlider.value = '1';
    binding.activate();

    const maxSensitivityRange = q<HTMLInputElement>('maxSensitivityRange');
    const minSensitivityRange = q<HTMLInputElement>('minSensitivityRange');
    minSensitivityRange.value = '50';

    maxSensitivityRange.value = '100';
    maxSensitivityRange.dispatchEvent(new Event('input'));

    minSensitivityRange.value = '120';

    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    expect(q<HTMLSpanElement>('sensitivityRangeStatusText').textContent).toBe(
      'Max must be greater than min'
    );
  });

  it('shows error when v < lastGoodSensitivity (race: sensitivity increases between input and save)', async () => {
    const { binding, q } = makeSetup();
    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    sensitivitySlider.value = '10';
    const pollHandler = binding.activate();

    pollHandler(entries({ [SENS_KEY]: 10 }));

    const maxSensitivityRange = q<HTMLInputElement>('maxSensitivityRange');
    const minSensitivityRange = q<HTMLInputElement>('minSensitivityRange');
    minSensitivityRange.value = '1';

    maxSensitivityRange.value = '50';
    maxSensitivityRange.dispatchEvent(new Event('input'));

    pollHandler(entries({ [SENS_KEY]: 100 }));

    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    expect(q<HTMLSpanElement>('sensitivityRangeStatusText').textContent).toBe(
      'Max cannot be below current sensitivity'
    );
  });
});

// ── Null protocol guards ──────────────────────────────────────────────────────

describe('null protocol guards', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('saveSensitivity: does not call protocol.send when conn.protocol is null', async () => {
    const { binding, protocol, conn, q } = makeSetup();
    binding.activate();
    (conn as unknown as Record<string, unknown>).protocol = null;

    const slider = q<HTMLInputElement>('sensitivitySlider');
    slider.value = '100';
    slider.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    expect(protocol.send).not.toHaveBeenCalled();
  });

  it('saveMinSensitivity: does not call protocol.send when conn.protocol is null', async () => {
    const { binding, protocol, conn, q } = makeSetup();
    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    sensitivitySlider.value = '200';
    binding.activate();
    (conn as unknown as Record<string, unknown>).protocol = null;

    const slider = q<HTMLInputElement>('minSensitivityRange');
    slider.value = '30';
    slider.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    expect(protocol.send).not.toHaveBeenCalled();
  });

  it('saveMaxSensitivity: does not call protocol.send when conn.protocol is null', async () => {
    const { binding, protocol, conn, q } = makeSetup();
    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    sensitivitySlider.value = '1';
    binding.activate();
    (conn as unknown as Record<string, unknown>).protocol = null;

    const slider = q<HTMLInputElement>('maxSensitivityRange');
    slider.value = '200';
    slider.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    expect(protocol.send).not.toHaveBeenCalled();
  });
});

// ── Rollback body when lastGood is already set ────────────────────────────────

describe('rollback body with non-null lastGood value', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('rollbackMin restores lastGoodMinSensitivity when a constraint is violated after a prior successful save', async () => {
    const { binding, protocol, q } = makeSetup();
    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    sensitivitySlider.value = '200';
    binding.activate();

    const minRange = q<HTMLInputElement>('minSensitivityRange');
    const maxRange = q<HTMLInputElement>('maxSensitivityRange');
    maxRange.value = '200';

    // Phase 1: successful save → lastGoodMinSensitivity = 30
    minRange.value = '30';
    minRange.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);
    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_MIN_SENSITIVITY,
      RESPONSE_STATUS.SUCCESS
    );

    // Phase 2: user inputs 150, max races to 100
    minRange.value = '150';
    minRange.dispatchEvent(new Event('input'));
    maxRange.value = '100';

    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    expect(minRange.value).toBe('30');
  });

  it('rollbackMax restores lastGoodMaxSensitivity when a constraint is violated after a prior successful save', async () => {
    const { binding, protocol, q } = makeSetup();
    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    sensitivitySlider.value = '1';
    binding.activate();

    const minRange = q<HTMLInputElement>('minSensitivityRange');
    const maxRange = q<HTMLInputElement>('maxSensitivityRange');
    minRange.value = '1';

    // Phase 1: successful save → lastGoodMaxSensitivity = 200
    maxRange.value = '200';
    maxRange.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);
    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_MAX_SENSITIVITY,
      RESPONSE_STATUS.SUCCESS
    );

    // Phase 2: user inputs 150, min races to 180
    maxRange.value = '150';
    maxRange.dispatchEvent(new Event('input'));
    minRange.value = '180';

    await vi.advanceTimersByTimeAsync(SENSITIVITY_DEBOUNCE_MS);

    expect(maxRange.value).toBe('200');
  });
});

// ── Max onInput clamping ──────────────────────────────────────────────────────

describe('max range onInput clamping', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('clamps max slider value up to lastGoodSensitivity when value drops below it', () => {
    const { binding, q } = makeSetup();
    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    sensitivitySlider.value = '100';
    binding.activate();

    const minRange = q<HTMLInputElement>('minSensitivityRange');
    const maxRange = q<HTMLInputElement>('maxSensitivityRange');
    minRange.value = '1';

    maxRange.value = '50';
    maxRange.dispatchEvent(new Event('input'));

    expect(maxRange.value).toBe('100');
  });
});

// ── hasPending suppression for range sliders ──────────────────────────────────

describe('range slider hasPending suppression', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('poll update is suppressed when min range slider has a pending debounce', () => {
    const { binding, q } = makeSetup();

    const sensitivitySlider = q<HTMLInputElement>('sensitivitySlider');
    sensitivitySlider.value = '100';

    const pollHandler = binding.activate();

    pollHandler(entries({ [MIN_KEY]: 10 }));

    const minRange = q<HTMLInputElement>('minSensitivityRange');
    minRange.value = '30';
    minRange.dispatchEvent(new Event('input'));

    pollHandler(entries({ [MIN_KEY]: 50 }));

    expect(minRange.value).toBe('30');
  });

  it('poll update is suppressed when max range slider has a pending debounce', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();

    pollHandler(entries({ [MAX_KEY]: 255 }));

    const maxRange = q<HTMLInputElement>('maxSensitivityRange');
    maxRange.value = '200';
    maxRange.dispatchEvent(new Event('input'));

    pollHandler(entries({ [MAX_KEY]: 150 }));

    expect(maxRange.value).toBe('200');
  });
});

// ── "Updated" status for range sliders ───────────────────────────────────────

describe('range slider "Updated" status (fromDevice)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('second min range poll with a different value shows "Updated"', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();

    pollHandler(entries({ [MIN_KEY]: 1 }));
    expect(q<HTMLSpanElement>('sensitivityRangeStatusText').textContent).toBe(
      ''
    );

    pollHandler(entries({ [MIN_KEY]: 50 }));
    expect(q<HTMLSpanElement>('sensitivityRangeStatusText').textContent).toBe(
      'Updated'
    );
  });

  it('second max range poll with a different value shows "Updated"', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();

    pollHandler(entries({ [MAX_KEY]: 255 }));
    expect(q<HTMLSpanElement>('sensitivityRangeStatusText').textContent).toBe(
      ''
    );

    pollHandler(entries({ [MAX_KEY]: 200 }));
    expect(q<HTMLSpanElement>('sensitivityRangeStatusText').textContent).toBe(
      'Updated'
    );
  });
});

// ── cleanup ───────────────────────────────────────────────────────────────────

describe('cleanup()', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('hides sensitivitySection', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(entries({ [SENS_KEY]: 50 }));
    expect(q('sensitivitySection').classList.contains('hidden')).toBe(false);
    binding.cleanup();
    expect(q('sensitivitySection').classList.contains('hidden')).toBe(true);
  });

  it('hides sensitivityRangeSection', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(entries({ [MIN_KEY]: 1, [MAX_KEY]: 255 }));
    expect(q('sensitivityRangeSection').classList.contains('hidden')).toBe(
      false
    );
    binding.cleanup();
    expect(q('sensitivityRangeSection').classList.contains('hidden')).toBe(
      true
    );
  });
});
