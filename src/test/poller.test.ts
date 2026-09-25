import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Poller } from '../poller';

describe('Poller', () => {
  let sendGas: ReturnType<typeof vi.fn>;
  let poller: Poller;

  beforeEach(() => {
    vi.useFakeTimers();
    sendGas = vi.fn();
    poller = new Poller(sendGas as () => void, 1000);
  });

  afterEach(() => {
    poller.stop();
    vi.useRealTimers();
  });

  it('does not poll before start()', () => {
    vi.advanceTimersByTime(2000);
    expect(sendGas).not.toHaveBeenCalled();
  });

  it('fires first poll immediately on start, without waiting for the interval', () => {
    poller.start();
    expect(sendGas).toHaveBeenCalledTimes(1);
  });

  it('fires interval polls after the immediate one', () => {
    poller.start();
    vi.advanceTimersByTime(3000); // immediate + 3 intervals
    expect(sendGas).toHaveBeenCalledTimes(4);
  });

  it('skips interval poll when activeCommands > 0', () => {
    poller.start();
    // immediate tick fires synchronously
    poller.beginCommand();
    vi.advanceTimersByTime(1000); // interval tick skipped
    expect(sendGas).toHaveBeenCalledTimes(1);
    poller.endCommand();
  });

  it('resumes polling after command completes', () => {
    poller.start();
    poller.beginCommand();
    vi.advanceTimersByTime(1000); // skipped
    poller.endCommand();
    vi.advanceTimersByTime(1000); // resumes
    expect(sendGas).toHaveBeenCalledTimes(2);
  });

  it('stops polling after stop()', () => {
    poller.start();
    vi.advanceTimersByTime(1000); // immediate + 1 interval
    poller.stop();
    vi.advanceTimersByTime(3000);
    expect(sendGas).toHaveBeenCalledTimes(2);
  });

  it('resets _pendingCommands on restart so first poll fires normally', () => {
    poller.start();
    poller.stop();
    sendGas.mockClear();
    poller.start();
    expect(sendGas).toHaveBeenCalledTimes(1);
  });

  it('stops polling when the AbortSignal fires', () => {
    const abort = new AbortController();
    poller.start(abort.signal);
    vi.advanceTimersByTime(1000); // immediate + 1 interval
    abort.abort();
    vi.advanceTimersByTime(3000);
    expect(sendGas).toHaveBeenCalledTimes(2);
  });

  it('start() without a signal still works normally', () => {
    poller.start();
    vi.advanceTimersByTime(2000); // immediate + 2 intervals
    expect(sendGas).toHaveBeenCalledTimes(3);
  });

  it('unbalanced endCommand() drives _pendingCommands negative, which does NOT block polls (_pendingCommands > 0 guard)', () => {
    poller.start();
    // immediate tick fires synchronously

    poller.endCommand(); // _pendingCommands = -1 (NOT > 0, so polls are NOT blocked)
    vi.advanceTimersByTime(1000); // interval fires
    expect(sendGas).toHaveBeenCalledTimes(2); // immediate + 1 interval
  });

  it('restart after negative _pendingCommands resets the counter and resumes polling', () => {
    poller.start();
    poller.endCommand(); // drive counter negative

    poller.stop();
    sendGas.mockClear();
    poller.start(); // restart resets _pendingCommands to 0
    expect(sendGas).toHaveBeenCalledTimes(1);
  });

  it('beginCommand/endCommand pair around a poll does not double-fire', () => {
    poller.start();
    poller.beginCommand();
    vi.advanceTimersByTime(1000); // interval would fire but skipped
    poller.endCommand();
    vi.advanceTimersByTime(1000); // now fires
    expect(sendGas).toHaveBeenCalledTimes(2); // immediate + 1 resumed
  });
});
