import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeSaver } from '../save-command';
import { RESPONSE_STATUS } from '../../protocol/command';
import type { Poller } from '../poller';
import type { CommandProtocol } from '../../protocol/command';

function makeElements() {
  return {
    dot: { className: '' } as unknown as HTMLSpanElement,
    text: { textContent: '' } as unknown as HTMLSpanElement,
  };
}

function makePoller() {
  return {
    beginCommand: vi.fn(),
    endCommand: vi.fn(),
  } as unknown as Poller;
}

function makeProtocol() {
  type ResponseHandler = (
    g: number,
    c: number,
    s: number,
    d: Uint8Array
  ) => void;
  const handlers: ResponseHandler[] = [];
  const protocol = {
    send: vi.fn(),
    on: vi
      .fn()
      .mockImplementation((_event: string, handler: ResponseHandler) => {
        handlers.push(handler);
      }),
    off: vi
      .fn()
      .mockImplementation((_event: string, handler: ResponseHandler) => {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }),
    _simulateResponse(
      g: number,
      c: number,
      s: number,
      d: Uint8Array = new Uint8Array()
    ) {
      for (const h of [...handlers]) h(g, c, s, d);
    },
    _handlerCount() {
      return handlers.length;
    },
  } as unknown as CommandProtocol & {
    _simulateResponse: (
      g: number,
      c: number,
      s: number,
      d?: Uint8Array
    ) => void;
    _handlerCount: () => number;
  };
  return protocol;
}

const GROUP = 0x01;
const CMD = 0x03;

describe('makeSaver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls protocol.send with the correct group, cmd, and payload', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test'
    );
    const payload = new Uint8Array([0xaa, 0xbb]);

    save(payload);

    expect(protocol.send).toHaveBeenCalledOnce();
    expect(protocol.send).toHaveBeenCalledWith(GROUP, CMD, payload);
  });

  it('registers a response listener before calling send()', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const callOrder: string[] = [];
    (protocol.on as ReturnType<typeof vi.fn>).mockImplementation(
      (_e: string, h: unknown) => {
        callOrder.push('on');
        // store handler for later simulation
        (protocol as unknown as { _handlers: unknown[] })._handlers =
          (protocol as unknown as { _handlers: unknown[] })._handlers ?? [];
        (protocol as unknown as { _handlers: unknown[] })._handlers.push(h);
      }
    );
    (protocol.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('send');
    });

    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test'
    );
    save(new Uint8Array());

    expect(callOrder).toEqual(['on', 'send']);
  });

  it('sets success status and calls onSuccess when SUCCESS response arrives', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const onSuccess = vi.fn();
    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test'
    );

    save(new Uint8Array(), onSuccess);
    protocol._simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);

    expect(dot.className).toContain('status-success');
    expect(text.textContent).toBe('Saved');
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('sets error status and calls onFailure when ERROR response arrives', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const onFailure = vi.fn();
    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test'
    );

    save(new Uint8Array(), undefined, onFailure);
    protocol._simulateResponse(GROUP, CMD, RESPONSE_STATUS.ERROR);

    expect(dot.className).toContain('status-error');
    expect(text.textContent).toBe('Save failed');
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('sets error status and calls onFailure on timeout', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const onFailure = vi.fn();
    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test',
      500
    );

    save(new Uint8Array(), undefined, onFailure);
    vi.advanceTimersByTime(500);

    expect(dot.className).toContain('status-error');
    expect(text.textContent).toBe('Save failed');
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('removes the response listener after SUCCESS response', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test'
    );

    save(new Uint8Array());
    expect(protocol._handlerCount()).toBe(1);
    protocol._simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
    expect(protocol.off).toHaveBeenCalledOnce();
    expect(protocol._handlerCount()).toBe(0);
  });

  it('removes the response listener after timeout', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test',
      200
    );

    save(new Uint8Array());
    expect(protocol._handlerCount()).toBe(1);
    vi.advanceTimersByTime(200);
    expect(protocol.off).toHaveBeenCalledOnce();
    expect(protocol._handlerCount()).toBe(0);
  });

  it('done flag prevents double-processing: a second matching response is ignored', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const onSuccess = vi.fn();
    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test'
    );

    save(new Uint8Array(), onSuccess);
    protocol._simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
    protocol._simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('done flag prevents timeout after response already received', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const onFailure = vi.fn();
    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test',
      500
    );

    save(new Uint8Array(), undefined, onFailure);
    protocol._simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS); // done = true
    vi.advanceTimersByTime(500); // timeout fires but is a no-op

    expect(onFailure).not.toHaveBeenCalled();
  });

  it('ignores responses for a different group', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const onSuccess = vi.fn();
    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test',
      500
    );

    save(new Uint8Array(), onSuccess);
    protocol._simulateResponse(0x02, CMD, RESPONSE_STATUS.SUCCESS); // wrong group
    expect(onSuccess).not.toHaveBeenCalled();

    protocol._simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS); // correct
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('ignores responses for a different cmd', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const onSuccess = vi.fn();
    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test',
      500
    );

    save(new Uint8Array(), onSuccess);
    protocol._simulateResponse(GROUP, 0x99, RESPONSE_STATUS.SUCCESS); // wrong cmd
    expect(onSuccess).not.toHaveBeenCalled();

    protocol._simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('calls beginCommand before sending', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const poller = makePoller();
    const callOrder: string[] = [];
    (poller.beginCommand as ReturnType<typeof vi.fn>).mockImplementation(() =>
      callOrder.push('begin')
    );
    (protocol.send as ReturnType<typeof vi.fn>).mockImplementation(() =>
      callOrder.push('send')
    );

    const { save } = makeSaver(
      () => poller,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test'
    );
    save(new Uint8Array());

    expect(callOrder[0]).toBe('begin');
    expect(callOrder[callOrder.length - 1]).toBe('send');
  });

  it('calls endCommand after SUCCESS response', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const poller = makePoller();
    const { save } = makeSaver(
      () => poller,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test'
    );

    save(new Uint8Array());
    expect(poller.endCommand).not.toHaveBeenCalled();
    protocol._simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
    expect(poller.endCommand).toHaveBeenCalledOnce();
  });

  it('calls endCommand after timeout', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const poller = makePoller();
    const { save } = makeSaver(
      () => poller,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test',
      200
    );

    save(new Uint8Array());
    vi.advanceTimersByTime(200);
    expect(poller.endCommand).toHaveBeenCalledOnce();
  });

  it('returns early without doing anything when getProtocol() returns null', () => {
    const { dot, text } = makeElements();
    const poller = makePoller();
    const { save } = makeSaver(
      () => poller,
      () => null,
      GROUP,
      CMD,
      dot,
      text,
      'test'
    );

    save(new Uint8Array());

    expect(poller.beginCommand).not.toHaveBeenCalled();
  });

  it('reads the poller from the getter at invocation time', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    let currentPoller: Poller | null = null;
    const { save } = makeSaver(
      () => currentPoller,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test'
    );

    save(new Uint8Array());
    // poller was null — beginCommand not called
    protocol._simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
    // set up a real poller, then invoke the second save
    const poller = makePoller();
    currentPoller = poller;
    save(new Uint8Array());
    expect(poller.beginCommand).toHaveBeenCalledTimes(1);
  });

  it('clears the timeout when SUCCESS response arrives before timeout', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const onFailure = vi.fn();
    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test',
      1000
    );

    save(new Uint8Array(), undefined, onFailure);
    protocol._simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
    vi.advanceTimersByTime(1000); // timeout would have fired

    expect(onFailure).not.toHaveBeenCalled();
  });

  it('concurrent save is a no-op while a save is already in-flight', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const onSuccess1 = vi.fn();
    const onSuccess2 = vi.fn();
    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test'
    );

    save(new Uint8Array([0x01]), onSuccess1);
    save(new Uint8Array([0x02]), onSuccess2); // blocked — first is in-flight

    expect(protocol.send).toHaveBeenCalledOnce(); // only the first send went through
    protocol._simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
    expect(onSuccess1).toHaveBeenCalledOnce();
    expect(onSuccess2).not.toHaveBeenCalled();
  });

  it('a second save() is allowed after the first completes', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const onSuccess = vi.fn();
    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test'
    );

    save(new Uint8Array([0x01]), onSuccess);
    protocol._simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);
    save(new Uint8Array([0x02]), onSuccess);
    protocol._simulateResponse(GROUP, CMD, RESPONSE_STATUS.SUCCESS);

    expect(onSuccess).toHaveBeenCalledTimes(2);
  });

  it('cleanup() cancels an in-flight save: removes listener, clears timeout, calls endCommand', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const poller = makePoller();
    const onFailure = vi.fn();
    const { save, cleanup } = makeSaver(
      () => poller,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test',
      1000
    );

    save(new Uint8Array(), undefined, onFailure);
    expect(protocol._handlerCount()).toBe(1);

    cleanup();

    expect(protocol._handlerCount()).toBe(0);
    expect(poller.endCommand).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000); // timeout should not fire after cleanup
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('cleanup() does nothing when no save is in-flight', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const { cleanup } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test'
    );

    expect(() => cleanup()).not.toThrow();
    expect(protocol.on).not.toHaveBeenCalled();
  });

  it('protocol.send() throwing calls onFailure and removes the listener', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    const onFailure = vi.fn();
    (protocol.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Previous frame not yet acknowledged');
    });
    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test'
    );

    save(new Uint8Array(), undefined, onFailure);

    expect(onFailure).toHaveBeenCalledOnce();
    expect(protocol._handlerCount()).toBe(0);
    expect(dot.className).toContain('status-error');
  });

  it('protocol.send() throwing allows a subsequent save() to proceed', () => {
    const { dot, text } = makeElements();
    const protocol = makeProtocol();
    let shouldThrow = true;
    (protocol.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      if (shouldThrow) throw new Error('not ready');
    });
    const { save } = makeSaver(
      () => null,
      () => protocol,
      GROUP,
      CMD,
      dot,
      text,
      'test'
    );

    save(new Uint8Array()); // throws — clears in-flight state
    shouldThrow = false;
    save(new Uint8Array()); // should proceed normally
    expect(protocol.send).toHaveBeenCalledTimes(2);
  });
});
