import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setFieldStatus, STATUS_AUTO_CLEAR_MS } from '../field-status';

function makeElements() {
  return {
    dot: { className: '' } as unknown as HTMLSpanElement,
    text: { textContent: '' } as unknown as HTMLSpanElement,
  };
}

describe('setFieldStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets className and textContent immediately', () => {
    const { dot, text } = makeElements();
    setFieldStatus(dot, text, 'success', 'Saved', true);
    expect(dot.className).toBe('status-indicator status-success');
    expect(text.textContent).toBe('Saved');
  });

  it('autoClear=false does not clear after STATUS_AUTO_CLEAR_MS', async () => {
    const { dot, text } = makeElements();
    setFieldStatus(dot, text, 'error', 'Error', false);
    await vi.advanceTimersByTimeAsync(STATUS_AUTO_CLEAR_MS + 100);
    expect(dot.className).toBe('status-indicator status-error');
    expect(text.textContent).toBe('Error');
  });

  it('autoClear=true clears to idle after STATUS_AUTO_CLEAR_MS', async () => {
    const { dot, text } = makeElements();
    setFieldStatus(dot, text, 'success', 'Saved', true);
    await vi.advanceTimersByTimeAsync(STATUS_AUTO_CLEAR_MS);
    expect(dot.className).toBe('status-indicator status-idle');
    expect(text.textContent).toBe('');
  });

  it('cancels pending auto-clear when a new status is set before timeout', async () => {
    const { dot, text } = makeElements();
    setFieldStatus(dot, text, 'success', 'Saved', true);
    setFieldStatus(dot, text, 'loading', 'Saving…', false);
    await vi.advanceTimersByTimeAsync(STATUS_AUTO_CLEAR_MS + 100);
    expect(dot.className).toBe('status-indicator status-loading');
    expect(text.textContent).toBe('Saving…');
  });

  it('error state persists through timeout', async () => {
    const { dot, text } = makeElements();
    setFieldStatus(dot, text, 'error', 'Error');
    await vi.advanceTimersByTimeAsync(STATUS_AUTO_CLEAR_MS * 3);
    expect(dot.className).toBe('status-indicator status-error');
  });

  it('independent instances do not interfere with each other', async () => {
    const a = makeElements();
    const b = makeElements();
    setFieldStatus(a.dot, a.text, 'success', 'Loaded', true);
    setFieldStatus(b.dot, b.text, 'success', 'Loaded', false);
    await vi.advanceTimersByTimeAsync(STATUS_AUTO_CLEAR_MS);
    expect(a.dot.className).toBe('status-indicator status-idle');
    expect(b.dot.className).toBe('status-indicator status-success');
    expect(b.text.textContent).toBe('Loaded');
  });
});
