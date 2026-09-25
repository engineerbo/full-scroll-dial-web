// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GROUP,
  CONFIG_CMD,
  TLV_TYPE,
  RESPONSE_STATUS,
} from '../../protocol/command';
import { backlashHtml, bindBacklashField } from '../config/fields/backlash';
import type { FieldContext } from '../config/field-utils';
import type { ConnectionManager } from '../connection';
import type { Poller } from '../poller';

const KEY = `${GROUP.CONFIG}-${CONFIG_CMD.GET_BACKLASH}`;

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
  container.innerHTML = backlashHtml;

  const protocol = makeMockProtocol();
  const conn = { protocol } as unknown as ConnectionManager;
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

  const binding = bindBacklashField(ctx);

  function q<T extends Element>(id: string): T {
    return container.querySelector(`#${id}`) as T;
  }

  return { binding, protocol, poller, pollLastSeen, q };
}

const entries = (v: number) => new Map([[KEY, new Uint8Array([v])]]);

describe('backlash field', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('reveals the card on the first poll and shows no status yet', () => {
    const { binding, q } = makeSetup();
    expect(q('backlashSection').classList.contains('hidden')).toBe(true);

    binding.activate()(entries(20));

    expect(q('backlashSection').classList.contains('hidden')).toBe(false);
    expect(q<HTMLInputElement>('backlashSlider').value).toBe('20');
    expect(q('backlashStatusText').textContent).toBe('');
  });

  it('renders tenths of a degree, and zero as Off', () => {
    const { binding, q } = makeSetup();
    const poll = binding.activate();

    poll(entries(0));
    expect(q('backlashValue').textContent).toBe('Off');

    poll(entries(15));
    expect(q('backlashValue').textContent).toBe('1.5°');

    poll(entries(255));
    expect(q('backlashValue').textContent).toBe('25.5°');
  });

  it('shows Updated when a later poll differs', () => {
    const { binding, q } = makeSetup();
    const poll = binding.activate();
    poll(entries(10));
    poll(entries(30));
    expect(q('backlashStatusText').textContent).toBe('Updated');
  });

  it('saves once after the debounce, and marks the poll as seen', () => {
    const { binding, protocol, pollLastSeen, q } = makeSetup();
    binding.activate()(entries(0));

    const slider = q<HTMLInputElement>('backlashSlider');
    slider.value = '25';
    slider.dispatchEvent(new Event('input'));
    expect(protocol.send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(protocol.send).toHaveBeenCalledTimes(1);
    expect(protocol.send).toHaveBeenCalledWith(
      GROUP.CONFIG,
      CONFIG_CMD.SET_BACKLASH,
      new Uint8Array([TLV_TYPE.BACKLASH, 1, 25])
    );

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_BACKLASH,
      RESPONSE_STATUS.SUCCESS
    );
    expect(q('backlashStatusText').textContent).toBe('Saved');
    expect(pollLastSeen.get(KEY)).toBe(25);
  });

  it('rolls back to the last good value when the device rejects it', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate()(entries(40));

    const slider = q<HTMLInputElement>('backlashSlider');
    slider.value = '200';
    slider.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(500);

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_BACKLASH,
      RESPONSE_STATUS.ERROR
    );

    expect(q('backlashStatusText').textContent).toBe('Save failed');
    expect(slider.value).toBe('40');
    expect(q('backlashValue').textContent).toBe('4.0°');
  });

  it('reports a failure when the device never answers', () => {
    const { binding, protocol, poller, q } = makeSetup();
    binding.activate()(entries(0));

    const slider = q<HTMLInputElement>('backlashSlider');
    slider.value = '12';
    slider.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(500);
    expect(poller.beginCommand).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(q('backlashStatusText').textContent).toBe('Save failed');
    expect(poller.endCommand).toHaveBeenCalledTimes(1);
    expect(protocol.off).toHaveBeenCalled();
  });

  it('ignores a poll while an edit is still pending', () => {
    const { binding, q } = makeSetup();
    const poll = binding.activate();
    poll(entries(0));

    const slider = q<HTMLInputElement>('backlashSlider');
    slider.value = '99';
    slider.dispatchEvent(new Event('input'));

    // A poll landing mid-edit must not yank the slider out from under the user
    poll(entries(50));
    expect(slider.value).toBe('99');
    expect(q('backlashValue').textContent).toBe('9.9°');
  });

  it('accepts polls again once the edit has been saved', () => {
    const { binding, protocol, q } = makeSetup();
    const poll = binding.activate();
    poll(entries(0));

    const slider = q<HTMLInputElement>('backlashSlider');
    slider.value = '99';
    slider.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(500);
    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_BACKLASH,
      RESPONSE_STATUS.SUCCESS
    );

    poll(entries(50));
    expect(slider.value).toBe('50');
    expect(q('backlashValue').textContent).toBe('5.0°');
  });

  it('hides the card again on cleanup', () => {
    const { binding, q } = makeSetup();
    binding.activate()(entries(20));
    binding.cleanup();
    expect(q('backlashSection').classList.contains('hidden')).toBe(true);
  });
});
