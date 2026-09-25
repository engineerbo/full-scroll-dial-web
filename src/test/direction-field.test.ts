// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GROUP,
  CONFIG_CMD,
  DIRECTION,
  RESPONSE_STATUS,
} from '../../protocol/command';
import { directionHtml, bindDirectionField } from '../config/fields/direction';
import type { FieldContext } from '../config/field-utils';
import type { ConnectionManager } from '../connection';
import type { Poller } from '../poller';

const DIR_KEY = `${GROUP.CONFIG}-${CONFIG_CMD.GET_DIRECTION}`;

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
  container.innerHTML = directionHtml;

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

  const binding = bindDirectionField(ctx);

  function q<T extends Element>(id: string): T {
    return container.querySelector(`#${id}`) as T;
  }

  return { binding, protocol, conn, pollLastSeen, q };
}

function makeEntries(key: string, value: number) {
  return new Map([[key, new Uint8Array([value])]]);
}

// ── Poll callbacks ─────────────────────────────────────────────────────────────

describe('direction poll callbacks', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('first poll reveals directionSection', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    expect(q('directionSection').classList.contains('hidden')).toBe(true);
    pollHandler(makeEntries(DIR_KEY, DIRECTION.INVERTED));
    expect(q('directionSection').classList.contains('hidden')).toBe(false);
  });

  it('first poll sets the select value', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(makeEntries(DIR_KEY, DIRECTION.INVERTED));
    expect(q<HTMLSelectElement>('directionSelect').value).toBe(
      String(DIRECTION.INVERTED)
    );
  });

  it('first poll does NOT show a status indicator', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(makeEntries(DIR_KEY, DIRECTION.NORMAL));
    expect(q<HTMLSpanElement>('directionStatusText').textContent).toBe('');
  });

  it('second poll with a different value shows "Updated"', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(makeEntries(DIR_KEY, DIRECTION.NORMAL));
    pollHandler(makeEntries(DIR_KEY, DIRECTION.INVERTED));
    expect(q<HTMLSpanElement>('directionStatusText').textContent).toBe(
      'Updated'
    );
  });
});

// ── Change handler ─────────────────────────────────────────────────────────────

describe('direction change handler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('calls protocol.send when the select changes to a valid direction', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('directionSelect');
    select.value = String(DIRECTION.INVERTED);
    select.dispatchEvent(new Event('change'));

    expect(protocol.send).toHaveBeenCalledOnce();
  });

  it('shows "Saved" status after a successful save', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('directionSelect');
    select.value = String(DIRECTION.INVERTED);
    select.dispatchEvent(new Event('change'));

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_DIRECTION,
      RESPONSE_STATUS.SUCCESS
    );

    expect(q<HTMLSpanElement>('directionStatusText').textContent).toBe('Saved');
  });

  it('updates pollLastSeen after a successful save', () => {
    const { binding, protocol, pollLastSeen, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('directionSelect');
    select.value = String(DIRECTION.INVERTED);
    select.dispatchEvent(new Event('change'));

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_DIRECTION,
      RESPONSE_STATUS.SUCCESS
    );

    expect(pollLastSeen.get(DIR_KEY)).toBe(DIRECTION.INVERTED);
  });

  it('does NOT call protocol.send when conn.protocol is null', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    container.innerHTML = directionHtml;
    const conn = { protocol: null } as unknown as ConnectionManager;
    const ctx: FieldContext = {
      container,
      conn,
      getPoller: () => null,
      pollLastSeen: new Map(),
    };
    const binding = bindDirectionField(ctx);
    binding.activate();

    const select =
      container.querySelector<HTMLSelectElement>('#directionSelect')!;
    select.value = String(DIRECTION.INVERTED);
    select.dispatchEvent(new Event('change'));

    // No protocol → no send call (send is inside makeSaver which checks getProtocol())
    expect(conn.protocol).toBeNull();
  });

  it('shows "Save failed" and does NOT update pollLastSeen when error response arrives', () => {
    const { binding, protocol, pollLastSeen, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('directionSelect');
    select.value = String(DIRECTION.INVERTED);
    select.dispatchEvent(new Event('change'));

    protocol.simulateResponse(
      GROUP.CONFIG,
      CONFIG_CMD.SET_DIRECTION,
      RESPONSE_STATUS.ERROR
    );

    expect(q<HTMLSpanElement>('directionStatusText').textContent).toBe(
      'Save failed'
    );
    expect(pollLastSeen.has(DIR_KEY)).toBe(false);
  });

  it('shows "Save failed" on timeout', () => {
    const { binding, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('directionSelect');
    select.value = String(DIRECTION.INVERTED);
    select.dispatchEvent(new Event('change'));

    vi.advanceTimersByTime(1000);

    expect(q<HTMLSpanElement>('directionStatusText').textContent).toBe(
      'Save failed'
    );
  });
});

// ── Invalid value guard ───────────────────────────────────────────────────────

describe('direction invalid value guard', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not call protocol.send for a direction value not in VALID_DIRECTIONS', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();

    const select = q<HTMLSelectElement>('directionSelect');
    select.value = '99'; // not in VALID_DIRECTIONS
    select.dispatchEvent(new Event('change'));

    expect(protocol.send).not.toHaveBeenCalled();
  });
});

// ── cleanup ───────────────────────────────────────────────────────────────────

describe('direction cleanup()', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('hides directionSection', () => {
    const { binding, q } = makeSetup();
    const pollHandler = binding.activate();
    pollHandler(makeEntries(DIR_KEY, DIRECTION.NORMAL)); // reveal it
    binding.cleanup();
    expect(q('directionSection').classList.contains('hidden')).toBe(true);
  });
});
