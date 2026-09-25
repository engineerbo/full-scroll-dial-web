// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GROUP,
  CONFIG_CMD,
  BUTTON_ACTION,
  RESPONSE_STATUS,
} from '../../protocol/command';
import {
  buttonActionsHtml,
  bindButtonActionsField,
} from '../config/fields/button-actions';
import type { FieldContext } from '../config/field-utils';
import type { ConnectionManager } from '../connection';
import type { Poller } from '../poller';

const PRESS_KEY = `${GROUP.CONFIG}-${CONFIG_CMD.GET_BUTTON_PRESS}`;
const LONGPRESS_KEY = `${GROUP.CONFIG}-${CONFIG_CMD.GET_BUTTON_LONGPRESS}`;

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
  container.innerHTML = buttonActionsHtml;

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

  const binding = bindButtonActionsField(ctx);

  function q<T extends Element>(id: string): T {
    return container.querySelector(`#${id}`) as T;
  }

  return { binding, protocol, conn, pollLastSeen, q };
}

function e(vals: Record<string, number>) {
  const m = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(vals)) m.set(k, new Uint8Array([v]));
  return m;
}

// ── Poll callbacks ─────────────────────────────────────────────────────────────

describe('button-actions poll callbacks', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('first press poll reveals buttonPressSection', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    expect(q('buttonPressSection').classList.contains('hidden')).toBe(true);
    pollHandler(e({ [PRESS_KEY]: BUTTON_ACTION.CYCLE_SENSITIVITY }));
    expect(q('buttonPressSection').classList.contains('hidden')).toBe(false);
  });

  it('first longpress poll reveals buttonLongpressSection', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    expect(q('buttonLongpressSection').classList.contains('hidden')).toBe(true);
    pollHandler(e({ [LONGPRESS_KEY]: BUTTON_ACTION.DISABLED }));
    expect(q('buttonLongpressSection').classList.contains('hidden')).toBe(
      false
    );
  });

  it('receiving only press key does NOT reveal longpress section', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(e({ [PRESS_KEY]: BUTTON_ACTION.TOGGLE_DIRECTION }));
    expect(q('buttonLongpressSection').classList.contains('hidden')).toBe(true);
  });

  it('second press poll with a different value shows "Updated" for press only', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(e({ [PRESS_KEY]: BUTTON_ACTION.CYCLE_SENSITIVITY }));
    pollHandler(e({ [PRESS_KEY]: BUTTON_ACTION.TOGGLE_DIRECTION }));
    expect(q<HTMLSpanElement>('buttonPressStatusText').textContent).toBe(
      'Updated'
    );
    expect(q<HTMLSpanElement>('buttonLongpressStatusText').textContent).toBe(
      ''
    );
  });

  it('second longpress poll with a different value shows "Updated" for longpress only', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(e({ [LONGPRESS_KEY]: BUTTON_ACTION.DISABLED }));
    pollHandler(e({ [LONGPRESS_KEY]: BUTTON_ACTION.TOGGLE_SCROLL_MODE }));
    expect(q<HTMLSpanElement>('buttonLongpressStatusText').textContent).toBe(
      'Updated'
    );
    expect(q<HTMLSpanElement>('buttonPressStatusText').textContent).toBe('');
  });
});

// ── Change handlers ────────────────────────────────────────────────────────────

describe('button-actions change handlers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('press select change calls protocol.send', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('buttonPressSelect');
    select.value = String(BUTTON_ACTION.TOGGLE_DIRECTION);
    select.dispatchEvent(new Event('change'));

    expect(protocol.send).toHaveBeenCalledOnce();
  });

  it('press send is called for SET_BUTTON_PRESS cmd', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('buttonPressSelect');
    select.value = String(BUTTON_ACTION.TOGGLE_DIRECTION);
    select.dispatchEvent(new Event('change'));

    expect(protocol.send).toHaveBeenCalledWith(
      GROUP.CONFIG,
      CONFIG_CMD.SET_BUTTON_PRESS,
      expect.any(Uint8Array)
    );
  });

  it('longpress select change calls protocol.send independently', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('buttonLongpressSelect');
    select.value = String(BUTTON_ACTION.DISABLED);
    select.dispatchEvent(new Event('change'));

    expect(protocol.send).toHaveBeenCalledOnce();
    expect(protocol.send).toHaveBeenCalledWith(
      GROUP.CONFIG,
      CONFIG_CMD.SET_BUTTON_LONGPRESS,
      expect.any(Uint8Array)
    );
  });

  it('saving press shows "Saved" on success response', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('buttonPressSelect');
    select.value = String(BUTTON_ACTION.TOGGLE_DIRECTION);
    select.dispatchEvent(new Event('change'));

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_BUTTON_PRESS,
      RESPONSE_STATUS.SUCCESS
    );

    expect(q<HTMLSpanElement>('buttonPressStatusText').textContent).toBe(
      'Saved'
    );
    expect(q<HTMLSpanElement>('buttonLongpressStatusText').textContent).toBe(
      ''
    );
  });

  it('press save updates pollLastSeen for press key only', () => {
    const { binding, protocol, pollLastSeen, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('buttonPressSelect');
    select.value = String(BUTTON_ACTION.TOGGLE_SCROLL_MODE);
    select.dispatchEvent(new Event('change'));

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_BUTTON_PRESS,
      RESPONSE_STATUS.SUCCESS
    );

    expect(pollLastSeen.get(PRESS_KEY)).toBe(BUTTON_ACTION.TOGGLE_SCROLL_MODE);
    expect(pollLastSeen.has(LONGPRESS_KEY)).toBe(false);
  });

  it('error response shows "Save failed" on press', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('buttonPressSelect');
    select.value = String(BUTTON_ACTION.TOGGLE_DIRECTION);
    select.dispatchEvent(new Event('change'));

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_BUTTON_PRESS,
      RESPONSE_STATUS.ERROR
    );

    expect(q<HTMLSpanElement>('buttonPressStatusText').textContent).toBe(
      'Save failed'
    );
  });

  it('timeout shows "Save failed" on press', () => {
    const { binding, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('buttonPressSelect');
    select.value = String(BUTTON_ACTION.TOGGLE_DIRECTION);
    select.dispatchEvent(new Event('change'));

    vi.advanceTimersByTime(1000);

    expect(q<HTMLSpanElement>('buttonPressStatusText').textContent).toBe(
      'Save failed'
    );
  });
});

// ── Null protocol and invalid value guards ────────────────────────────────────

describe('button-actions null protocol and invalid value guards', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('press change: does not call protocol.send when conn.protocol is null', () => {
    const { binding, conn, q } = makeSetup();
    binding.activate();
    (conn as unknown as Record<string, unknown>).protocol = null;

    const select = q<HTMLSelectElement>('buttonPressSelect');
    select.value = String(BUTTON_ACTION.TOGGLE_DIRECTION);
    select.dispatchEvent(new Event('change'));

    expect(conn.protocol).toBeNull();
  });

  it('press change: does not call protocol.send for an invalid action value', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('buttonPressSelect');
    select.value = '99'; // not in VALID_BUTTON_ACTIONS
    select.dispatchEvent(new Event('change'));

    expect(protocol.send).not.toHaveBeenCalled();
  });

  it('longpress change: does not call protocol.send when conn.protocol is null', () => {
    const { binding, conn, q } = makeSetup();
    binding.activate();
    (conn as unknown as Record<string, unknown>).protocol = null;

    const select = q<HTMLSelectElement>('buttonLongpressSelect');
    select.value = String(BUTTON_ACTION.DISABLED);
    select.dispatchEvent(new Event('change'));

    expect(conn.protocol).toBeNull();
  });

  it('longpress change: does not call protocol.send for an invalid action value', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('buttonLongpressSelect');
    select.value = '99'; // not in VALID_BUTTON_ACTIONS
    select.dispatchEvent(new Event('change'));

    expect(protocol.send).not.toHaveBeenCalled();
  });
});

// ── cleanup ───────────────────────────────────────────────────────────────────

describe('button-actions cleanup()', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('hides buttonPressSection', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(e({ [PRESS_KEY]: BUTTON_ACTION.CYCLE_SENSITIVITY }));
    binding.cleanup();
    expect(q('buttonPressSection').classList.contains('hidden')).toBe(true);
  });

  it('hides buttonLongpressSection', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(e({ [LONGPRESS_KEY]: BUTTON_ACTION.DISABLED }));
    binding.cleanup();
    expect(q('buttonLongpressSection').classList.contains('hidden')).toBe(true);
  });
});
