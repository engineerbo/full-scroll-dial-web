// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GROUP,
  CORE_CMD,
  TLV_TYPE,
  SELFTEST_RESULT,
  RESPONSE_STATUS,
  CMD_ERROR,
} from '../../protocol/command';
import { selfTestHtml, bindSelfTestField } from '../config/fields/self-test';
import type { FieldContext } from '../config/field-utils';
import type { ConnectionManager } from '../connection';
import type { Poller } from '../poller';

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
  return { send, on, off, simulateResponse, handlers };
}

/** [result TLV] optionally followed by [encoder diagnostics TLV] */
function response(code: number, diagnostics?: [number, number, number]) {
  const out = [TLV_TYPE.SELFTEST_RESULT, 1, code];
  if (diagnostics) {
    const [status, agc, magnitude] = diagnostics;
    out.push(
      TLV_TYPE.SELFTEST_ENCODER,
      4,
      status,
      agc,
      magnitude & 0xff,
      (magnitude >> 8) & 0xff
    );
  }
  return new Uint8Array(out);
}

function makeSetup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  container.innerHTML = selfTestHtml;

  const protocol = makeMockProtocol();
  const conn = { protocol } as unknown as ConnectionManager;
  const poller = {
    beginCommand: vi.fn(),
    endCommand: vi.fn(),
  } as unknown as Poller;

  const ctx: FieldContext = {
    container,
    conn,
    getPoller: () => poller,
    pollLastSeen: new Map<string, number>(),
  };

  const binding = bindSelfTestField(ctx);

  function q<T extends Element>(id: string): T {
    return container.querySelector(`#${id}`) as T;
  }

  return { binding, protocol, poller, conn, container, q };
}

describe('self-test field', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('reveals itself from activate(), since it has nothing to poll', () => {
    const { binding, q } = makeSetup();
    expect(q('selfTestSection').classList.contains('hidden')).toBe(true);
    binding.activate();
    expect(q('selfTestSection').classList.contains('hidden')).toBe(false);
  });

  it('sends CORE_RUN_SELFTEST and gates the poller for the exchange', () => {
    const { binding, protocol, poller, q } = makeSetup();
    binding.activate();

    q<HTMLButtonElement>('selfTestRunBtn').click();

    expect(protocol.send).toHaveBeenCalledWith(
      GROUP.CORE,
      CORE_CMD.RUN_SELFTEST
    );
    expect(poller.beginCommand).toHaveBeenCalledTimes(1);
    expect(poller.endCommand).not.toHaveBeenCalled();
    expect(q<HTMLButtonElement>('selfTestRunBtn').disabled).toBe(true);

    protocol.simulateResponse(
      GROUP.CORE,
      CORE_CMD.RUN_SELFTEST,
      RESPONSE_STATUS.SUCCESS,
      response(SELFTEST_RESULT.OK)
    );

    expect(poller.endCommand).toHaveBeenCalledTimes(1);
    expect(q<HTMLButtonElement>('selfTestRunBtn').disabled).toBe(false);
    expect(q('selfTestMessage').textContent).toBe('Self-test passed');
  });

  it('shows the diagnostics behind a magnet verdict', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();

    protocol.simulateResponse(
      GROUP.CORE,
      CORE_CMD.RUN_SELFTEST,
      RESPONSE_STATUS.SUCCESS,
      response(SELFTEST_RESULT.MAGNET_TOO_WEAK, [0x10, 118, 250])
    );

    expect(q('selfTestMessage').textContent).toBe(
      `Magnet too far away (code ${SELFTEST_RESULT.MAGNET_TOO_WEAK})`
    );
    expect(q('selfTestDiagnostics').classList.contains('hidden')).toBe(false);
    expect(q('selfTestAgc').textContent).toBe('118 / 128');
    expect(q('selfTestMagnitude').textContent).toBe('250');
  });

  it('hides diagnostics when the device could not read them', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();

    protocol.simulateResponse(
      GROUP.CORE,
      CORE_CMD.RUN_SELFTEST,
      RESPONSE_STATUS.SUCCESS,
      response(SELFTEST_RESULT.UNPOWERED)
    );

    expect(q('selfTestMessage').textContent).toBe(
      `Switch the dial on and try again (code ${SELFTEST_RESULT.UNPOWERED})`
    );
    expect(q('selfTestDiagnostics').classList.contains('hidden')).toBe(true);
  });

  it('recovers on timeout and releases the poller gate', () => {
    const { binding, protocol, poller, q } = makeSetup();
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();

    vi.advanceTimersByTime(2000);

    expect(poller.endCommand).toHaveBeenCalledTimes(1);
    expect(q<HTMLButtonElement>('selfTestRunBtn').disabled).toBe(false);
    expect(q('selfTestMessage').textContent).toBe(
      'The device did not respond.'
    );
    expect(protocol.off).toHaveBeenCalled();
  });

  it('ignores responses for other commands', () => {
    const { binding, protocol, poller, q } = makeSetup();
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();

    protocol.simulateResponse(
      GROUP.CORE,
      CORE_CMD.GET_ALL_STATES,
      RESPONSE_STATUS.SUCCESS,
      new Uint8Array([1, 2, 3])
    );

    expect(poller.endCommand).not.toHaveBeenCalled();
    expect(q<HTMLButtonElement>('selfTestRunBtn').disabled).toBe(true);
  });

  it('shows passing diagnostics with the decoded status register', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();

    protocol.simulateResponse(
      GROUP.CORE,
      CORE_CMD.RUN_SELFTEST,
      RESPONSE_STATUS.SUCCESS,
      response(SELFTEST_RESULT.OK, [0x20 | 0x07, 61, 0x0abc])
    );

    expect(q('selfTestMessage').textContent).toBe('Self-test passed');
    expect(q('selfTestStatusText').textContent).toBe('Passed');
    expect(q('selfTestAgc').textContent).toBe('61 / 128');
    expect(q('selfTestMagnitude').textContent).toBe(`${0x0abc}`);
    // Reserved bits ignored in the decode, but the raw byte is kept
    expect(q('selfTestStatusReg').textContent).toBe(
      'detected, in range (0x27)'
    );
  });

  it('marks a failing verdict as failed', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();

    protocol.simulateResponse(
      GROUP.CORE,
      CORE_CMD.RUN_SELFTEST,
      RESPONSE_STATUS.SUCCESS,
      response(SELFTEST_RESULT.ADDRESS_NACK)
    );

    expect(q('selfTestStatusText').textContent).toBe('Failed');
    expect(q('selfTestMessage').textContent).toBe(
      `Sensor not responding (code ${SELFTEST_RESULT.ADDRESS_NACK})`
    );
  });

  it('hides diagnostics from a previous run when a new run starts', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();
    protocol.simulateResponse(
      GROUP.CORE,
      CORE_CMD.RUN_SELFTEST,
      RESPONSE_STATUS.SUCCESS,
      response(SELFTEST_RESULT.OK, [0x20, 61, 2000])
    );
    expect(q('selfTestDiagnostics').classList.contains('hidden')).toBe(false);

    q<HTMLButtonElement>('selfTestRunBtn').click();

    expect(q('selfTestDiagnostics').classList.contains('hidden')).toBe(true);
    expect(q('selfTestMessage').textContent).toBe('Testing…');
    expect(q('selfTestStatusText').textContent).toBe('Running…');
  });

  it('hides diagnostics when the encoder TLV is truncated', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();

    protocol.simulateResponse(
      GROUP.CORE,
      CORE_CMD.RUN_SELFTEST,
      RESPONSE_STATUS.SUCCESS,
      new Uint8Array([
        ...response(SELFTEST_RESULT.OK),
        TLV_TYPE.SELFTEST_ENCODER,
        3,
        0x20,
        61,
        0x12,
      ])
    );

    expect(q('selfTestMessage').textContent).toBe('Self-test passed');
    expect(q('selfTestDiagnostics').classList.contains('hidden')).toBe(true);
  });

  it('reports a response without a result TLV as unreadable', () => {
    const { binding, protocol, poller, q } = makeSetup();
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();

    protocol.simulateResponse(
      GROUP.CORE,
      CORE_CMD.RUN_SELFTEST,
      RESPONSE_STATUS.SUCCESS,
      new Uint8Array()
    );

    expect(q('selfTestStatusText').textContent).toBe('Failed');
    expect(q('selfTestMessage').textContent).toBe(
      'The device sent an unreadable result.'
    );
    expect(q<HTMLButtonElement>('selfTestRunBtn').disabled).toBe(false);
    expect(poller.endCommand).toHaveBeenCalledTimes(1);
  });

  it('reports a zero-length result TLV as unreadable', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();

    protocol.simulateResponse(
      GROUP.CORE,
      CORE_CMD.RUN_SELFTEST,
      RESPONSE_STATUS.SUCCESS,
      new Uint8Array([TLV_TYPE.SELFTEST_RESULT, 0])
    );

    expect(q('selfTestMessage').textContent).toBe(
      'The device sent an unreadable result.'
    );
  });

  it('reports other command errors generically', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();

    protocol.simulateResponse(
      GROUP.CORE,
      CORE_CMD.RUN_SELFTEST,
      RESPONSE_STATUS.ERROR,
      new Uint8Array([CMD_ERROR.INTERNAL])
    );

    expect(q('selfTestStatusText').textContent).toBe('Failed');
    expect(q('selfTestMessage').textContent).toBe(
      'Could not run the self-test.'
    );
    expect(q<HTMLButtonElement>('selfTestRunBtn').disabled).toBe(false);
  });

  it('reports an error response with no code generically', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();

    protocol.simulateResponse(
      GROUP.CORE,
      CORE_CMD.RUN_SELFTEST,
      RESPONSE_STATUS.ERROR
    );

    expect(q('selfTestMessage').textContent).toBe(
      'Could not run the self-test.'
    );
  });

  it('recovers when send() throws', () => {
    const { binding, protocol, poller, q } = makeSetup();
    protocol.send.mockImplementationOnce(() => {
      throw new Error('busy');
    });
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();

    expect(q('selfTestStatusText').textContent).toBe('Failed');
    expect(q('selfTestMessage').textContent).toBe(
      'Could not run the self-test.'
    );
    expect(q<HTMLButtonElement>('selfTestRunBtn').disabled).toBe(false);
    expect(poller.endCommand).toHaveBeenCalledTimes(1);
  });

  it('reports not connected when there is no protocol', () => {
    const { binding, conn, poller, q } = makeSetup();
    (conn as { protocol: unknown }).protocol = null;
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();

    expect(q('selfTestStatusText').textContent).toBe('Failed');
    expect(q('selfTestMessage').textContent).toBe('Not connected.');
    expect(q<HTMLButtonElement>('selfTestRunBtn').disabled).toBe(false);
    expect(poller.beginCommand).not.toHaveBeenCalled();
  });

  it('returns a no-op poll handler from activate()', () => {
    const { binding } = makeSetup();
    const handler = binding.activate();
    expect(() => handler(new Map())).not.toThrow();
  });

  it('cleanup restores the idle state after a run', () => {
    const { binding, protocol, q } = makeSetup();
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();
    protocol.simulateResponse(
      GROUP.CORE,
      CORE_CMD.RUN_SELFTEST,
      RESPONSE_STATUS.SUCCESS,
      response(SELFTEST_RESULT.MAGNET_TOO_WEAK, [0x30, 128, 100])
    );
    const idleMessage =
      'Checks the rotation sensor and the magnet inside the dial.';

    binding.cleanup();

    expect(q('selfTestDiagnostics').classList.contains('hidden')).toBe(true);
    expect(q<HTMLButtonElement>('selfTestRunBtn').disabled).toBe(false);
    expect(q('selfTestMessage').textContent?.trim()).toBe(idleMessage);
  });

  it('cancels an in-flight run on cleanup, balancing the poller gate', () => {
    const { binding, protocol, poller, q } = makeSetup();
    binding.activate();
    q<HTMLButtonElement>('selfTestRunBtn').click();

    binding.cleanup();

    expect(poller.endCommand).toHaveBeenCalledTimes(1);
    expect(protocol.handlers).toHaveLength(0);
    expect(q('selfTestSection').classList.contains('hidden')).toBe(true);
  });
});
