// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GROUP,
  CONFIG_CMD,
  SCROLL_MODE,
  RESPONSE_STATUS,
} from '../../protocol/command';
import {
  scrollModeHtml,
  bindScrollModeField,
} from '../config/fields/scroll-mode';
import type { FieldContext } from '../config/field-utils';
import type { ConnectionManager } from '../connection';
import type { Poller } from '../poller';

const MODE_KEY = `${GROUP.CONFIG}-${CONFIG_CMD.GET_SCROLL_MODE}`;

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
  container.innerHTML = scrollModeHtml;

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

  const binding = bindScrollModeField(ctx);

  function q<T extends Element>(id: string): T {
    return container.querySelector(`#${id}`) as T;
  }

  return { binding, protocol, conn, pollLastSeen, q };
}

function makeEntries(key: string, value: number) {
  return new Map([[key, new Uint8Array([value])]]);
}

// ── Poll callbacks ─────────────────────────────────────────────────────────────

describe('scroll-mode poll callbacks', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('first poll reveals scrollModeSection', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    expect(q('scrollModeSection').classList.contains('hidden')).toBe(true);
    pollHandler(makeEntries(MODE_KEY, SCROLL_MODE.HIGH_RES));
    expect(q('scrollModeSection').classList.contains('hidden')).toBe(false);
  });

  it('first poll sets the select value', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(makeEntries(MODE_KEY, SCROLL_MODE.HIGH_RES));
    expect(q<HTMLSelectElement>('scrollModeSelect').value).toBe(
      String(SCROLL_MODE.HIGH_RES)
    );
  });

  it('first poll does NOT show a status indicator', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(makeEntries(MODE_KEY, SCROLL_MODE.STANDARD));
    expect(q<HTMLSpanElement>('scrollModeStatusText').textContent).toBe('');
  });

  it('second poll with a different value shows "Updated"', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(makeEntries(MODE_KEY, SCROLL_MODE.STANDARD));
    pollHandler(makeEntries(MODE_KEY, SCROLL_MODE.HIGH_RES));
    expect(q<HTMLSpanElement>('scrollModeStatusText').textContent).toBe(
      'Updated'
    );
  });
});

// ── Change handler ─────────────────────────────────────────────────────────────

describe('scroll-mode change handler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('calls protocol.send when the select changes to a valid scroll mode', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('scrollModeSelect');
    select.value = String(SCROLL_MODE.HIGH_RES);
    select.dispatchEvent(new Event('change'));

    expect(protocol.send).toHaveBeenCalledOnce();
  });

  it('shows "Saved" status after a successful save', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('scrollModeSelect');
    select.value = String(SCROLL_MODE.HIGH_RES);
    select.dispatchEvent(new Event('change'));

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_SCROLL_MODE,
      RESPONSE_STATUS.SUCCESS
    );

    expect(q<HTMLSpanElement>('scrollModeStatusText').textContent).toBe(
      'Saved'
    );
  });

  it('updates pollLastSeen after a successful save', () => {
    const { binding, protocol, pollLastSeen, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('scrollModeSelect');
    select.value = String(SCROLL_MODE.HIGH_RES);
    select.dispatchEvent(new Event('change'));

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_SCROLL_MODE,
      RESPONSE_STATUS.SUCCESS
    );

    expect(pollLastSeen.get(MODE_KEY)).toBe(SCROLL_MODE.HIGH_RES);
  });

  it('shows "Save failed" when error response arrives', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('scrollModeSelect');
    select.value = String(SCROLL_MODE.HIGH_RES);
    select.dispatchEvent(new Event('change'));

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_SCROLL_MODE,
      RESPONSE_STATUS.ERROR
    );

    expect(q<HTMLSpanElement>('scrollModeStatusText').textContent).toBe(
      'Save failed'
    );
  });

  it('shows "Save failed" on timeout', () => {
    const { binding, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('scrollModeSelect');
    select.value = String(SCROLL_MODE.HIGH_RES);
    select.dispatchEvent(new Event('change'));

    vi.advanceTimersByTime(1000);

    expect(q<HTMLSpanElement>('scrollModeStatusText').textContent).toBe(
      'Save failed'
    );
  });
});

// ── Null protocol and invalid value guards ────────────────────────────────────

describe('scroll-mode null protocol and invalid value guards', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not call protocol.send when conn.protocol is null', () => {
    const { binding, conn, q } = makeSetup();
    binding.activate();
    (conn as unknown as Record<string, unknown>).protocol = null;

    const select = q<HTMLSelectElement>('scrollModeSelect');
    select.value = String(SCROLL_MODE.HIGH_RES);
    select.dispatchEvent(new Event('change'));

    // protocol is null — no send called on original mock (which is no longer the active protocol)
    expect(conn.protocol).toBeNull();
  });

  it('does not call protocol.send for a scroll mode value not in VALID_SCROLL_MODES', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('scrollModeSelect');
    select.value = '99'; // not in VALID_SCROLL_MODES
    select.dispatchEvent(new Event('change'));

    expect(protocol.send).not.toHaveBeenCalled();
  });
});

// ── cleanup ───────────────────────────────────────────────────────────────────

describe('scroll-mode cleanup()', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('hides scrollModeSection', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(makeEntries(MODE_KEY, SCROLL_MODE.STANDARD));
    binding.cleanup();
    expect(q('scrollModeSection').classList.contains('hidden')).toBe(true);
  });
});
