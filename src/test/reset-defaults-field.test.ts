// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GROUP,
  CORE_CMD,
  RESPONSE_STATUS,
  CMD_ERROR,
} from '../../protocol/command';
import {
  resetDefaultsHtml,
  bindResetDefaultsField,
  RESET_CONFIRM_MS,
} from '../config/fields/reset-defaults';
import { RUN_COMMAND_TIMEOUT_MS } from '../run-command';
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

function makeSetup(withProtocol = true) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  container.innerHTML = resetDefaultsHtml;

  const protocol = makeMockProtocol();
  const conn = {
    protocol: withProtocol ? protocol : null,
  } as unknown as ConnectionManager;
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

  const binding = bindResetDefaultsField(ctx);

  function q<T extends Element>(id: string): T {
    return container.querySelector(`#${id}`) as T;
  }
  const btn = q<HTMLButtonElement>('resetDefaultsBtn');
  const statusText = () => q('resetDefaultsStatusText').textContent;
  const message = () => q('resetDefaultsMessage').textContent?.trim();

  return { binding, protocol, poller, q, btn, statusText, message };
}

function respond(
  protocol: ReturnType<typeof makeMockProtocol>,
  status: number = RESPONSE_STATUS.SUCCESS
) {
  protocol.simulateResponse(GROUP.CORE, CORE_CMD.RESET_DEFAULTS, status);
}

describe('reset-defaults field', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('reveals itself from activate() and returns a no-op poll handler', () => {
    const { binding, q } = makeSetup();
    expect(q('resetDefaultsSection').classList.contains('hidden')).toBe(true);
    const onPoll = binding.activate();
    expect(q('resetDefaultsSection').classList.contains('hidden')).toBe(false);
    expect(() => onPoll(new Map())).not.toThrow();
  });

  it('arms on the first click without sending anything', () => {
    const { binding, protocol, btn } = makeSetup();
    binding.activate();

    btn.click();

    expect(protocol.send).not.toHaveBeenCalled();
    expect(btn.textContent).toBe('Confirm restore defaults');
    expect(btn.className).toContain('bg-red-600');
  });

  it('disarms after the confirmation window passes', () => {
    const { binding, protocol, btn } = makeSetup();
    binding.activate();

    btn.click();
    vi.advanceTimersByTime(RESET_CONFIRM_MS);

    expect(btn.textContent).toBe('Restore defaults');
    expect(btn.className).not.toContain('bg-red-600');

    // A click after disarming only re-arms
    btn.click();
    expect(protocol.send).not.toHaveBeenCalled();
  });

  it('sends CORE_RESET_DEFAULTS on the second click and gates the poller', () => {
    const { binding, protocol, poller, btn, statusText } = makeSetup();
    binding.activate();

    btn.click();
    btn.click();

    expect(protocol.send).toHaveBeenCalledTimes(1);
    expect(protocol.send).toHaveBeenCalledWith(
      GROUP.CORE,
      CORE_CMD.RESET_DEFAULTS
    );
    expect(poller.beginCommand).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('Restore defaults');
    expect(statusText()).toBe('Restoring…');
  });

  it('reports success and re-enables the button', () => {
    const { binding, protocol, poller, btn, statusText, message } = makeSetup();
    binding.activate();

    btn.click();
    btn.click();
    respond(protocol);

    expect(poller.endCommand).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(false);
    expect(statusText()).toBe('Restored');
    expect(message()).toBe('Settings restored to factory defaults.');
  });

  it('reports an error status', () => {
    const { binding, protocol, btn, statusText, message } = makeSetup();
    binding.activate();

    btn.click();
    btn.click();
    respond(protocol, CMD_ERROR.INTERNAL);

    expect(btn.disabled).toBe(false);
    expect(statusText()).toBe('Failed');
    expect(message()).toBe('Could not restore defaults.');
  });

  it('reports a timeout and releases the poller gate', () => {
    const { binding, poller, btn, statusText, message } = makeSetup();
    binding.activate();

    btn.click();
    btn.click();
    vi.advanceTimersByTime(RUN_COMMAND_TIMEOUT_MS);

    expect(poller.endCommand).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(false);
    expect(statusText()).toBe('Failed');
    expect(message()).toBe('The device did not respond.');
  });

  it('reports send() failures generically', () => {
    const { binding, protocol, btn, message } = makeSetup();
    protocol.send.mockImplementation(() => {
      throw new Error('busy');
    });
    binding.activate();

    btn.click();
    btn.click();

    expect(btn.disabled).toBe(false);
    expect(message()).toBe('Could not restore defaults.');
  });

  it('reports not connected when there is no protocol', () => {
    const { binding, btn, statusText, message } = makeSetup(false);
    binding.activate();

    btn.click();
    btn.click();

    expect(btn.disabled).toBe(false);
    expect(statusText()).toBe('Failed');
    expect(message()).toBe('Not connected.');
  });

  it('cleanup disarms an armed button and hides the card', () => {
    const { binding, protocol, btn, q } = makeSetup();
    binding.activate();

    btn.click();
    binding.cleanup();

    expect(btn.textContent).toBe('Restore defaults');
    expect(q('resetDefaultsSection').classList.contains('hidden')).toBe(true);

    // The stale arm timer must not leave the button armed after reconnect
    binding.activate();
    btn.click();
    expect(protocol.send).not.toHaveBeenCalled();
  });

  it('cleanup cancels an in-flight reset, balancing the poller gate', () => {
    const { binding, protocol, poller, btn, statusText, message } = makeSetup();
    binding.activate();

    btn.click();
    btn.click();
    binding.cleanup();

    expect(poller.endCommand).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(false);
    expect(statusText()).toBe('');
    expect(message()).toBe('Restores all settings to their default values.');

    // A late response is ignored
    respond(protocol);
    expect(statusText()).toBe('');
  });
});
