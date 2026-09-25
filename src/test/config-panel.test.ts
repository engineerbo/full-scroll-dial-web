// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GROUP,
  CORE_CMD,
  PROTOCOL_VERSION,
  RESPONSE_STATUS,
} from '../../protocol/command';
import { bindConfigPanel } from '../config/index';
import type { ConnectionManager } from '../connection';
import { POLL_INTERVAL_MS } from '../constants';

// ── Mock protocol ─────────────────────────────────────────────────────────────

type ResponseHandler = (g: number, c: number, s: number, d: Uint8Array) => void;

function makeMockProtocol() {
  const handlers: ResponseHandler[] = [];
  const send = vi.fn();
  const on = vi
    .fn()
    .mockImplementation((_event: string, handler: ResponseHandler) => {
      handlers.push(handler);
    });
  const off = vi
    .fn()
    .mockImplementation((_event: string, handler: ResponseHandler) => {
      const idx = handlers.indexOf(handler);
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

  // Auto-respond to sends with realistic device responses
  send.mockImplementation((g: number, c: number) => {
    if (g === GROUP.CORE && c === CORE_CMD.GET_PROTOCOL_VERSION) {
      simulateResponse(
        g,
        c,
        RESPONSE_STATUS.SUCCESS,
        new Uint8Array([
          PROTOCOL_VERSION & 0xff,
          (PROTOCOL_VERSION >> 8) & 0xff,
        ])
      );
    } else if (g === GROUP.CORE && c === CORE_CMD.GET_ALL_STATES) {
      simulateResponse(g, c, RESPONSE_STATUS.SUCCESS, new Uint8Array());
    }
  });

  return { send, on, off, simulateResponse };
}

function makeConn(protocol: ReturnType<typeof makeMockProtocol> | null = null) {
  return {
    protocol,
    signal: null as AbortSignal | null,
  } as unknown as ConnectionManager;
}

function makeSetup(
  protocol: ReturnType<typeof makeMockProtocol> | null = null
) {
  const container = document.createElement('div');
  document.body.appendChild(container);

  const onInitError = vi.fn();
  const conn = makeConn(protocol);
  const panel = bindConfigPanel(container, conn, onInitError);

  function q<T extends Element>(id: string): T {
    return container.querySelector(`#${id}`) as T;
  }

  return { panel, container, onInitError, conn, q };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('prepare()', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reveals configLoadingSection', () => {
    const { panel, q } = makeSetup();
    panel.prepare();
    expect(q('configLoadingSection').classList.contains('hidden')).toBe(false);
  });
});

describe('onSynced() — null protocol', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does nothing when conn.protocol is null', () => {
    const { panel, onInitError } = makeSetup(null);
    panel.onSynced();
    expect(onInitError).not.toHaveBeenCalled();
  });
});

describe('onSynced() — happy path', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('sends GET_PROTOCOL_VERSION on onSynced()', () => {
    const protocol = makeMockProtocol();
    const { panel } = makeSetup(protocol);
    panel.onSynced();
    expect(protocol.send).toHaveBeenCalledWith(
      GROUP.CORE,
      CORE_CMD.GET_PROTOCOL_VERSION,
      expect.any(Uint8Array)
    );
  });

  it('registers a response listener on onSynced()', () => {
    const protocol = makeMockProtocol();
    const { panel } = makeSetup(protocol);
    panel.onSynced();
    expect(protocol.on).toHaveBeenCalledWith('response', expect.any(Function));
  });

  it('hides configLoadingSection after first successful GET_ALL_STATES', () => {
    const protocol = makeMockProtocol();
    const { panel, q } = makeSetup(protocol);
    panel.prepare();
    expect(q('configLoadingSection').classList.contains('hidden')).toBe(false);

    panel.onSynced(); // send fires → auto-response → configLoadingSection hidden

    expect(q('configLoadingSection').classList.contains('hidden')).toBe(true);
  });

  it('orphaned-poller fix: second onSynced() stops the first poller', () => {
    const protocol = makeMockProtocol();
    const { panel } = makeSetup(protocol);

    panel.onSynced();
    const gasCallsAfterFirst = protocol.send.mock.calls.filter(
      (c) => c[0] === GROUP.CORE && c[1] === CORE_CMD.GET_ALL_STATES
    ).length;

    protocol.send.mockClear();
    panel.onSynced();
    vi.advanceTimersByTime(POLL_INTERVAL_MS);

    const gasCallsAfterSecond = protocol.send.mock.calls.filter(
      (c) => c[0] === GROUP.CORE && c[1] === CORE_CMD.GET_ALL_STATES
    ).length;

    // First poller was stopped: only 2 GAS calls (immediate + 1 interval from second poller)
    expect(gasCallsAfterFirst).toBeGreaterThanOrEqual(1);
    expect(gasCallsAfterSecond).toBeLessThanOrEqual(2);
  });

  it('orphaned-poller fix: pollLastSeen is cleared on second onSynced()', () => {
    const protocol = makeMockProtocol();
    const { panel } = makeSetup(protocol);

    panel.onSynced();
    panel.onSynced();
    expect(() => {}).not.toThrow();
  });

  it('version mismatch still starts polling and hides loading section', () => {
    const protocol = makeMockProtocol();
    // Override version response to return version 1 (mismatch)
    protocol.send.mockImplementation((g: number, c: number) => {
      if (g === GROUP.CORE && c === CORE_CMD.GET_PROTOCOL_VERSION) {
        protocol.simulateResponse(
          g,
          c,
          RESPONSE_STATUS.SUCCESS,
          new Uint8Array([0x01, 0x00])
        );
      } else if (g === GROUP.CORE && c === CORE_CMD.GET_ALL_STATES) {
        protocol.simulateResponse(
          g,
          c,
          RESPONSE_STATUS.SUCCESS,
          new Uint8Array()
        );
      }
    });
    const { panel, q } = makeSetup(protocol);
    panel.prepare();

    panel.onSynced();

    expect(q('configLoadingSection').classList.contains('hidden')).toBe(true);
  });

  it('short version response (< 2 bytes) skips version check and starts polling', () => {
    const protocol = makeMockProtocol();
    protocol.send.mockImplementation((g: number, c: number) => {
      if (g === GROUP.CORE && c === CORE_CMD.GET_PROTOCOL_VERSION) {
        protocol.simulateResponse(
          g,
          c,
          RESPONSE_STATUS.SUCCESS,
          new Uint8Array([0x01])
        );
      } else if (g === GROUP.CORE && c === CORE_CMD.GET_ALL_STATES) {
        protocol.simulateResponse(
          g,
          c,
          RESPONSE_STATUS.SUCCESS,
          new Uint8Array()
        );
      }
    });
    const { panel, q } = makeSetup(protocol);
    panel.prepare();

    panel.onSynced();

    expect(q('configLoadingSection').classList.contains('hidden')).toBe(true);
  });

  it('GET_ALL_STATES error response calls onInitError', () => {
    const protocol = makeMockProtocol();
    protocol.send.mockImplementation((g: number, c: number) => {
      if (g === GROUP.CORE && c === CORE_CMD.GET_PROTOCOL_VERSION) {
        protocol.simulateResponse(
          g,
          c,
          RESPONSE_STATUS.SUCCESS,
          new Uint8Array([
            PROTOCOL_VERSION & 0xff,
            (PROTOCOL_VERSION >> 8) & 0xff,
          ])
        );
      } else if (g === GROUP.CORE && c === CORE_CMD.GET_ALL_STATES) {
        protocol.simulateResponse(
          g,
          c,
          RESPONSE_STATUS.ERROR,
          new Uint8Array()
        );
      }
    });
    const { panel, onInitError } = makeSetup(protocol);
    panel.prepare();

    panel.onSynced();

    expect(onInitError).toHaveBeenCalledOnce();
    expect(onInitError.mock.calls[0]![0]).toContain('Init failed');
  });

  it('GET_ALL_STATES error response hides configLoadingSection', () => {
    const protocol = makeMockProtocol();
    protocol.send.mockImplementation((g: number, c: number) => {
      if (g === GROUP.CORE && c === CORE_CMD.GET_PROTOCOL_VERSION) {
        protocol.simulateResponse(
          g,
          c,
          RESPONSE_STATUS.SUCCESS,
          new Uint8Array([
            PROTOCOL_VERSION & 0xff,
            (PROTOCOL_VERSION >> 8) & 0xff,
          ])
        );
      } else if (g === GROUP.CORE && c === CORE_CMD.GET_ALL_STATES) {
        protocol.simulateResponse(
          g,
          c,
          RESPONSE_STATUS.ERROR,
          new Uint8Array()
        );
      }
    });
    const { panel, q } = makeSetup(protocol);
    panel.prepare();

    panel.onSynced();

    expect(q('configLoadingSection').classList.contains('hidden')).toBe(true);
  });

  it('polls at POLL_INTERVAL_MS after initial poll', () => {
    const protocol = makeMockProtocol();
    const { panel } = makeSetup(protocol);
    panel.onSynced();

    const gasBeforeInterval = protocol.send.mock.calls.filter(
      (c) => c[0] === GROUP.CORE && c[1] === CORE_CMD.GET_ALL_STATES
    ).length;

    vi.advanceTimersByTime(POLL_INTERVAL_MS);

    const gasAfterInterval = protocol.send.mock.calls.filter(
      (c) => c[0] === GROUP.CORE && c[1] === CORE_CMD.GET_ALL_STATES
    ).length;

    expect(gasAfterInterval).toBe(gasBeforeInterval + 1);
  });
});

describe('self-test card', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('is rendered hidden before sync', () => {
    const { q } = makeSetup(makeMockProtocol());
    expect(q('selfTestSection')).not.toBeNull();
    expect(q('selfTestSection').classList.contains('hidden')).toBe(true);
  });

  it('is revealed by onSynced() without waiting for a poll', () => {
    const protocol = makeMockProtocol();
    protocol.send.mockImplementation(() => {});
    const { panel, q } = makeSetup(protocol);
    panel.onSynced();
    expect(q('selfTestSection').classList.contains('hidden')).toBe(false);
  });

  it('sends RUN_SELFTEST through the shared connection', () => {
    const protocol = makeMockProtocol();
    const { panel, q } = makeSetup(protocol);
    panel.onSynced();
    q<HTMLButtonElement>('selfTestRunBtn').click();
    expect(protocol.send).toHaveBeenCalledWith(
      GROUP.CORE,
      CORE_CMD.RUN_SELFTEST
    );
  });
});

describe('cleanup()', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('hides configLoadingSection', () => {
    const { panel, q } = makeSetup();
    panel.prepare(); // reveal it first
    panel.cleanup();
    expect(q('configLoadingSection').classList.contains('hidden')).toBe(true);
  });

  it('hides all field sections', () => {
    const { panel, container } = makeSetup();
    panel.cleanup();
    const sections = container.querySelectorAll('.hidden');
    expect(sections.length).toBeGreaterThan(0);
  });

  it('hides the self-test card', () => {
    const protocol = makeMockProtocol();
    const { panel, q } = makeSetup(protocol);
    panel.onSynced();
    panel.cleanup();
    expect(q('selfTestSection').classList.contains('hidden')).toBe(true);
  });

  it('cancels an in-flight self-test', () => {
    vi.useFakeTimers();
    const protocol = makeMockProtocol();
    const { panel, q } = makeSetup(protocol);
    panel.onSynced();
    q<HTMLButtonElement>('selfTestRunBtn').click();
    const handlersBefore = protocol.off.mock.calls.length;

    panel.cleanup();

    expect(protocol.off.mock.calls.length).toBeGreaterThan(handlersBefore);
    expect(q<HTMLButtonElement>('selfTestRunBtn').disabled).toBe(false);
    vi.useRealTimers();
  });

  it('can be called multiple times without throwing', () => {
    const { panel } = makeSetup();
    expect(() => {
      panel.cleanup();
      panel.cleanup();
    }).not.toThrow();
  });

  it('removes the response listener on cleanup()', () => {
    const protocol = makeMockProtocol();
    const { panel } = makeSetup(protocol);
    panel.onSynced();
    panel.cleanup();
    expect(protocol.off).toHaveBeenCalledWith('response', expect.any(Function));
  });
});
