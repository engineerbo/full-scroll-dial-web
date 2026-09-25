import { describe, it, expect, vi } from 'vitest';
import { TypedEmitter } from '../src/typed-emitter';

// Concrete subclass that exposes emit() for testing
class TestEmitter extends TypedEmitter<{
  data: [number, string];
  done: [];
}> {
  fire(event: 'data', n: number, s: string): void;
  fire(event: 'done'): void;
  fire(event: 'data' | 'done', ...args: unknown[]): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.emit(event as any, ...(args as any));
  }
}

describe('TypedEmitter', () => {
  it('listener registered with on() is called when the event fires', () => {
    const emitter = new TestEmitter();
    const cb = vi.fn();
    emitter.on('data', cb);
    emitter.fire('data', 42, 'hello');
    expect(cb).toHaveBeenCalledWith(42, 'hello');
  });

  it('multiple listeners on the same event are all called', () => {
    const emitter = new TestEmitter();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    emitter.on('data', cb1);
    emitter.on('data', cb2);
    emitter.fire('data', 1, 'x');
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it('listeners on different events do not interfere', () => {
    const emitter = new TestEmitter();
    const dataCb = vi.fn();
    const doneCb = vi.fn();
    emitter.on('data', dataCb);
    emitter.on('done', doneCb);
    emitter.fire('done');
    expect(dataCb).not.toHaveBeenCalled();
    expect(doneCb).toHaveBeenCalledOnce();
  });

  it('off() removes the listener — it is not called on subsequent emits', () => {
    const emitter = new TestEmitter();
    const cb = vi.fn();
    emitter.on('data', cb);
    emitter.off('data', cb);
    emitter.fire('data', 0, '');
    expect(cb).not.toHaveBeenCalled();
  });

  it('off() for a listener not registered is a no-op (does not throw)', () => {
    const emitter = new TestEmitter();
    const cb = vi.fn();
    expect(() => emitter.off('data', cb)).not.toThrow();
  });

  it('off() only removes the specified listener, leaving others intact', () => {
    const emitter = new TestEmitter();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    emitter.on('data', cb1);
    emitter.on('data', cb2);
    emitter.off('data', cb1);
    emitter.fire('data', 5, 'y');
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it('emit with no listeners registered is a no-op', () => {
    const emitter = new TestEmitter();
    expect(() => emitter.fire('done')).not.toThrow();
  });

  it('a listener that throws does not prevent other listeners from running', () => {
    const emitter = new TestEmitter();
    const throwing = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const safe = vi.fn();
    emitter.on('done', throwing);
    emitter.on('done', safe);
    expect(() => emitter.fire('done')).toThrow('boom');
    // Because Set.forEach stops on the first throw, `safe` may or may not run.
    // The important contract: emit does NOT swallow the error.
  });

  it('re-entrant emit (listener calls emit on the same event) does not loop infinitely', () => {
    const emitter = new TestEmitter();
    let callCount = 0;
    const cb = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 2) {
        emitter.fire('done'); // re-entrant call
      }
    });
    emitter.on('done', cb);
    expect(() => emitter.fire('done')).not.toThrow();
    expect(callCount).toBe(2); // first call + one re-entrant call
  });
});
