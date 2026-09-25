import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeRunner, RUN_COMMAND_TIMEOUT_MS } from '../run-command';
import { RESPONSE_STATUS } from '../../protocol/command';
import type { Poller } from '../poller';
import type { CommandProtocol } from '../../protocol/command';

type ResponseHandler = (g: number, c: number, s: number, d: Uint8Array) => void;

function makePoller() {
  return {
    beginCommand: vi.fn(),
    endCommand: vi.fn(),
  } as unknown as Poller;
}

function makeProtocol() {
  const handlers: ResponseHandler[] = [];
  const protocol = {
    send: vi.fn(),
    on: vi.fn().mockImplementation((_e: string, h: ResponseHandler) => {
      handlers.push(h);
    }),
    off: vi.fn().mockImplementation((_e: string, h: ResponseHandler) => {
      const idx = handlers.indexOf(h);
      if (idx !== -1) handlers.splice(idx, 1);
    }),
  } as unknown as CommandProtocol;
  function simulateResponse(
    g: number,
    c: number,
    s: number,
    d: Uint8Array = new Uint8Array()
  ) {
    for (const h of [...handlers]) h(g, c, s, d);
  }
  return { protocol, handlers, simulateResponse };
}

const GROUP = 0x00;
const CMD = 0x06;

function makeSetup(timeoutMs?: number) {
  const poller = makePoller();
  const mock = makeProtocol();
  const runner = makeRunner(
    () => poller,
    () => mock.protocol,
    GROUP,
    CMD,
    'test',
    timeoutMs
  );
  return { poller, ...mock, ...runner };
}

describe('makeRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends the command without a payload and returns true', () => {
    const { protocol, run } = makeSetup();
    expect(run(vi.fn())).toBe(true);
    expect(protocol.send).toHaveBeenCalledWith(GROUP, CMD);
  });

  it('registers the response listener before sending', () => {
    const { protocol, run } = makeSetup();
    const order: string[] = [];
    vi.mocked(protocol.on).mockImplementationOnce(() => {
      order.push('on');
      return protocol;
    });
    vi.mocked(protocol.send).mockImplementationOnce(() => {
      order.push('send');
    });
    run(vi.fn());
    expect(order).toEqual(['on', 'send']);
  });

  it('returns false and does nothing when there is no protocol', () => {
    const poller = makePoller();
    const { run } = makeRunner(
      () => poller,
      () => null,
      GROUP,
      CMD,
      'test'
    );
    const onOutcome = vi.fn();
    expect(run(onOutcome)).toBe(false);
    expect(poller.beginCommand).not.toHaveBeenCalled();
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it('delivers the response payload on success', () => {
    const { run, simulateResponse } = makeSetup();
    const onOutcome = vi.fn();
    run(onOutcome);
    const data = new Uint8Array([1, 2, 3]);
    simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS, data);
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith({ ok: true, data });
  });

  it('delivers the status and error payload on an error response', () => {
    const { run, simulateResponse } = makeSetup();
    const onOutcome = vi.fn();
    run(onOutcome);
    const data = new Uint8Array([0x01]);
    simulateResponse(GROUP, CMD, RESPONSE_STATUS.ERROR, data);
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith({
      ok: false,
      reason: 'error-status',
      status: RESPONSE_STATUS.ERROR,
      data,
    });
  });

  it('reports a timeout after RUN_COMMAND_TIMEOUT_MS by default', () => {
    const { run } = makeSetup();
    const onOutcome = vi.fn();
    run(onOutcome);
    vi.advanceTimersByTime(RUN_COMMAND_TIMEOUT_MS - 1);
    expect(onOutcome).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith({
      ok: false,
      reason: 'timeout',
    });
  });

  it('outlasts the ARQ retry window', () => {
    // 5 retries x 250 ms; a shorter timeout aborts a legitimate recovery
    expect(RUN_COMMAND_TIMEOUT_MS).toBeGreaterThan(5 * 250);
  });

  it('honours a custom timeout', () => {
    const { run } = makeSetup(500);
    const onOutcome = vi.fn();
    run(onOutcome);
    vi.advanceTimersByTime(500);
    expect(onOutcome).toHaveBeenCalledWith({ ok: false, reason: 'timeout' });
  });

  it('reports send-failed and releases everything when send() throws', () => {
    const { protocol, poller, handlers, run } = makeSetup();
    vi.mocked(protocol.send).mockImplementationOnce(() => {
      throw new Error('busy');
    });
    const onOutcome = vi.fn();

    expect(run(onOutcome)).toBe(true);
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith({
      ok: false,
      reason: 'send-failed',
    });
    expect(poller.endCommand).toHaveBeenCalledTimes(1);
    expect(handlers).toHaveLength(0);

    // The timeout must have been cleared, not left to fire a second outcome
    vi.advanceTimersByTime(RUN_COMMAND_TIMEOUT_MS);
    expect(onOutcome).toHaveBeenCalledTimes(1);
  });

  it('allows a new run after send() throws', () => {
    const { protocol, run } = makeSetup();
    vi.mocked(protocol.send).mockImplementationOnce(() => {
      throw new Error('busy');
    });
    run(vi.fn());
    expect(run(vi.fn())).toBe(true);
    expect(protocol.send).toHaveBeenCalledTimes(2);
  });

  it('ignores responses for a different group or cmd', () => {
    const { run, simulateResponse } = makeSetup();
    const onOutcome = vi.fn();
    run(onOutcome);
    simulateResponse(GROUP + 1, CMD, RESPONSE_STATUS.SUCCESS);
    simulateResponse(GROUP, CMD + 1, RESPONSE_STATUS.SUCCESS);
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it('delivers exactly one outcome per run', () => {
    const { run, simulateResponse } = makeSetup();
    const onOutcome = vi.fn();
    run(onOutcome);
    simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
    simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
    vi.advanceTimersByTime(RUN_COMMAND_TIMEOUT_MS);
    expect(onOutcome).toHaveBeenCalledTimes(1);
  });

  it('rejects a second run while one is in flight', () => {
    const { protocol, poller, run } = makeSetup();
    run(vi.fn());
    expect(run(vi.fn())).toBe(false);
    expect(protocol.send).toHaveBeenCalledTimes(1);
    expect(poller.beginCommand).toHaveBeenCalledTimes(1);
  });

  it('allows a new run once the previous one finished', () => {
    const { protocol, run, simulateResponse } = makeSetup();
    run(vi.fn());
    simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
    expect(run(vi.fn())).toBe(true);
    expect(protocol.send).toHaveBeenCalledTimes(2);
  });

  it('holds the poller gate until the response arrives', () => {
    const { poller, run, simulateResponse } = makeSetup();
    run(vi.fn());
    expect(poller.beginCommand).toHaveBeenCalledTimes(1);
    expect(poller.endCommand).not.toHaveBeenCalled();
    simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
    expect(poller.endCommand).toHaveBeenCalledTimes(1);
  });

  it('releases the poller gate before invoking the callback', () => {
    const { poller, run, simulateResponse } = makeSetup();
    let endedBeforeCallback = false;
    run(() => {
      endedBeforeCallback = vi.mocked(poller.endCommand).mock.calls.length > 0;
    });
    simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
    expect(endedBeforeCallback).toBe(true);
  });

  it('works without a poller', () => {
    const mock = makeProtocol();
    const { run } = makeRunner(
      () => null,
      () => mock.protocol,
      GROUP,
      CMD,
      'test'
    );
    const onOutcome = vi.fn();
    run(onOutcome);
    mock.simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true })
    );
  });

  describe('cleanup()', () => {
    it('cancels an in-flight run silently and balances the poller gate', () => {
      const { poller, handlers, run, cleanup, simulateResponse } = makeSetup();
      const onOutcome = vi.fn();
      run(onOutcome);

      cleanup();

      expect(poller.endCommand).toHaveBeenCalledTimes(1);
      expect(handlers).toHaveLength(0);
      simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
      vi.advanceTimersByTime(RUN_COMMAND_TIMEOUT_MS);
      expect(onOutcome).not.toHaveBeenCalled();
    });

    it('allows a new run afterwards', () => {
      const { run, cleanup } = makeSetup();
      run(vi.fn());
      cleanup();
      expect(run(vi.fn())).toBe(true);
    });

    it('is a no-op when nothing is in flight', () => {
      const { poller, run, cleanup, simulateResponse } = makeSetup();
      cleanup();
      run(vi.fn());
      simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
      cleanup();
      expect(poller.endCommand).toHaveBeenCalledTimes(1);
    });
  });
});
