// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkPoll,
  makeFieldCallback,
  makeEnumSelectField,
  CARD,
  SELECT,
} from '../config/field-utils';
import type { FieldContext } from '../config/field-utils';
import type { ConnectionManager } from '../connection';
import type { Poller } from '../poller';

// ── checkPoll ─────────────────────────────────────────────────────────────────

describe('checkPoll', () => {
  it('does nothing when the key is absent from entries', () => {
    const pollLastSeen = new Map<string, number>();
    const onValue = vi.fn();
    checkPoll(new Map(), 'key', 0, pollLastSeen, onValue);
    expect(onValue).not.toHaveBeenCalled();
    expect(pollLastSeen.size).toBe(0);
  });

  it('calls onValue with the first entry byte on first encounter', () => {
    const pollLastSeen = new Map<string, number>();
    const onValue = vi.fn();
    const entries = new Map([['key', new Uint8Array([42])]]);
    checkPoll(entries, 'key', 0, pollLastSeen, onValue);
    expect(onValue).toHaveBeenCalledOnce();
    expect(onValue).toHaveBeenCalledWith(42);
  });

  it('updates pollLastSeen to the new value after calling onValue', () => {
    const pollLastSeen = new Map<string, number>();
    const onValue = vi.fn();
    const entries = new Map([['key', new Uint8Array([7])]]);
    checkPoll(entries, 'key', 0, pollLastSeen, onValue);
    expect(pollLastSeen.get('key')).toBe(7);
  });

  it('falls back to defaultValue when entry[0] is undefined (empty Uint8Array)', () => {
    const pollLastSeen = new Map<string, number>();
    const onValue = vi.fn();
    const entries = new Map([['key', new Uint8Array([])]]);
    checkPoll(entries, 'key', 99, pollLastSeen, onValue);
    expect(onValue).toHaveBeenCalledWith(99);
    expect(pollLastSeen.get('key')).toBe(99);
  });

  it('does NOT call onValue when the value equals the last-seen value', () => {
    const pollLastSeen = new Map<string, number>([['key', 42]]);
    const onValue = vi.fn();
    const entries = new Map([['key', new Uint8Array([42])]]);
    checkPoll(entries, 'key', 0, pollLastSeen, onValue);
    expect(onValue).not.toHaveBeenCalled();
  });

  it('does NOT mutate pollLastSeen when value is unchanged', () => {
    const pollLastSeen = new Map<string, number>([['key', 5]]);
    const entries = new Map([['key', new Uint8Array([5])]]);
    checkPoll(entries, 'key', 0, pollLastSeen, vi.fn());
    expect(pollLastSeen.get('key')).toBe(5);
  });

  it('calls onValue and updates pollLastSeen when value changes between polls', () => {
    const pollLastSeen = new Map<string, number>([['key', 10]]);
    const onValue = vi.fn();
    const entries = new Map([['key', new Uint8Array([20])]]);
    checkPoll(entries, 'key', 0, pollLastSeen, onValue);
    expect(onValue).toHaveBeenCalledWith(20);
    expect(pollLastSeen.get('key')).toBe(20);
  });

  it('calls onValue exactly once when the same entries are passed twice in a row', () => {
    const pollLastSeen = new Map<string, number>();
    const onValue = vi.fn();
    const entries = new Map([['key', new Uint8Array([5])]]);
    checkPoll(entries, 'key', 0, pollLastSeen, onValue);
    checkPoll(entries, 'key', 0, pollLastSeen, onValue);
    expect(onValue).toHaveBeenCalledTimes(1);
  });
});

// ── makeFieldCallback ─────────────────────────────────────────────────────────

describe('makeFieldCallback', () => {
  let section: HTMLDivElement;
  let dot: HTMLSpanElement;
  let text: HTMLSpanElement;
  let setter: (v: number) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    section = document.createElement('div');
    section.classList.add('hidden');
    dot = document.createElement('span');
    text = document.createElement('span');
    setter = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the setter with the value on first call', () => {
    const cb = makeFieldCallback(section, setter, dot, text);
    cb(42);
    expect(setter).toHaveBeenCalledWith(42);
  });

  it('reveals the section on first call', () => {
    const cb = makeFieldCallback(section, setter, dot, text);
    cb(42);
    expect(section.classList.contains('hidden')).toBe(false);
  });

  it('does NOT show a status indicator on the first call', () => {
    const cb = makeFieldCallback(section, setter, dot, text);
    cb(42);
    expect(dot.className).not.toContain('status-success');
    expect(text.textContent).toBe('');
  });

  it('shows "Updated" status indicator on the second call', () => {
    const cb = makeFieldCallback(section, setter, dot, text);
    cb(1);
    cb(2);
    expect(dot.className).toContain('status-success');
    expect(text.textContent).toBe('Updated');
  });

  it('keeps the section visible on the second call', () => {
    const cb = makeFieldCallback(section, setter, dot, text);
    cb(1);
    cb(2);
    expect(section.classList.contains('hidden')).toBe(false);
  });

  it('still calls setter with each new value on subsequent calls', () => {
    const cb = makeFieldCallback(section, setter, dot, text);
    cb(10);
    cb(20);
    cb(30);
    expect(setter).toHaveBeenCalledTimes(3);
    expect(setter).toHaveBeenLastCalledWith(30);
  });
});

// ── makeEnumSelectField ───────────────────────────────────────────────────────

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

const FAKE_TLV_TYPE = 0x42;
const FAKE_GROUP = 0x01;
const FAKE_SET_CMD = 0x03;
const FAKE_POLL_KEY = `${FAKE_GROUP}-${0x02}`;
const VALID_VALUES = new Set([0, 1]);

const FIELD_HTML = `
<div id="testSection" class="${CARD}">
  <span id="testStatus" class="status-indicator status-idle"></span>
  <span id="testStatusText"></span>
  <select id="testSelect" class="${SELECT}">
    <option value="0">Option A</option>
    <option value="1">Option B</option>
  </select>
</div>`;

function makeFieldSetup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  container.innerHTML = FIELD_HTML;

  const protocol = makeMockProtocol();
  const conn = { protocol } as unknown as ConnectionManager;
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

  const binding = makeEnumSelectField(ctx, {
    sectionId: 'testSection',
    selectId: 'testSelect',
    statusId: 'testStatus',
    statusTextId: 'testStatusText',
    pollKey: FAKE_POLL_KEY,
    validValues: VALID_VALUES,
    tlvType: FAKE_TLV_TYPE,
    setCmd: FAKE_SET_CMD,
    label: 'test field',
  });

  function q<T extends Element>(id: string): T {
    return container.querySelector(`#${id}`) as T;
  }

  return { binding, protocol, pollLastSeen, q };
}

describe('makeEnumSelectField — poll callbacks', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('first poll reveals the section', () => {
    const { binding, q } = makeFieldSetup();
    const handler = binding.activate();
    expect(q('testSection').classList.contains('hidden')).toBe(true);
    handler(new Map([[FAKE_POLL_KEY, new Uint8Array([1])]]));
    expect(q('testSection').classList.contains('hidden')).toBe(false);
  });

  it('first poll sets the select value', () => {
    const { binding, q } = makeFieldSetup();
    const handler = binding.activate();
    handler(new Map([[FAKE_POLL_KEY, new Uint8Array([1])]]));
    expect(q<HTMLSelectElement>('testSelect').value).toBe('1');
  });

  it('first poll does NOT show a status text', () => {
    const { binding, q } = makeFieldSetup();
    const handler = binding.activate();
    handler(new Map([[FAKE_POLL_KEY, new Uint8Array([0])]]));
    expect(q('testStatusText').textContent).toBe('');
  });

  it('second poll with a changed value shows "Updated"', () => {
    const { binding, q } = makeFieldSetup();
    const handler = binding.activate();
    handler(new Map([[FAKE_POLL_KEY, new Uint8Array([0])]]));
    handler(new Map([[FAKE_POLL_KEY, new Uint8Array([1])]]));
    expect(q('testStatusText').textContent).toBe('Updated');
  });

  it('poll with unchanged value does not call onValue again', () => {
    const { binding, q } = makeFieldSetup();
    const handler = binding.activate();
    handler(new Map([[FAKE_POLL_KEY, new Uint8Array([0])]]));
    const statusText = q<HTMLSpanElement>('testStatusText');
    statusText.textContent = '';
    handler(new Map([[FAKE_POLL_KEY, new Uint8Array([0])]])); // same value
    expect(statusText.textContent).toBe(''); // "Updated" did NOT fire
  });

  it('each activate() call resets the loaded flag (fresh "Updated" gate)', () => {
    const { binding, q } = makeFieldSetup();
    // First activation
    let handler = binding.activate();
    handler(new Map([[FAKE_POLL_KEY, new Uint8Array([0])]]));
    // Second activation — loaded flag should reset
    handler = binding.activate();
    handler(new Map([[FAKE_POLL_KEY, new Uint8Array([1])]]));
    expect(q('testStatusText').textContent).toBe(''); // first call after re-activate → no "Updated"
  });
});

describe('makeEnumSelectField — change handler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('dispatching a valid change calls protocol.send', () => {
    const { binding, protocol, q } = makeFieldSetup();
    binding.activate();
    const select = q<HTMLSelectElement>('testSelect');
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    expect(protocol.send).toHaveBeenCalledOnce();
  });

  it('dispatching an invalid value does NOT call protocol.send', () => {
    const { binding, protocol, q } = makeFieldSetup();
    binding.activate();
    const select = q<HTMLSelectElement>('testSelect');
    select.value = '99';
    select.dispatchEvent(new Event('change'));
    expect(protocol.send).not.toHaveBeenCalled();
  });

  it('successful response shows "Saved" and updates pollLastSeen', () => {
    const { binding, protocol, pollLastSeen, q } = makeFieldSetup();
    binding.activate();
    const select = q<HTMLSelectElement>('testSelect');
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    protocol.simulateResponse(FAKE_GROUP, FAKE_SET_CMD, 0x00);
    expect(q('testStatusText').textContent).toBe('Saved');
    expect(pollLastSeen.get(FAKE_POLL_KEY)).toBe(1);
  });

  it('error response shows "Save failed" and does NOT update pollLastSeen', () => {
    const { binding, protocol, pollLastSeen, q } = makeFieldSetup();
    binding.activate();
    const select = q<HTMLSelectElement>('testSelect');
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    protocol.simulateResponse(FAKE_GROUP, FAKE_SET_CMD, 0xff);
    expect(q('testStatusText').textContent).toBe('Save failed');
    expect(pollLastSeen.has(FAKE_POLL_KEY)).toBe(false);
  });

  it('timeout shows "Save failed"', () => {
    const { binding, q } = makeFieldSetup();
    binding.activate();
    const select = q<HTMLSelectElement>('testSelect');
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    vi.advanceTimersByTime(1000);
    expect(q('testStatusText').textContent).toBe('Save failed');
  });
});

describe('makeEnumSelectField — cleanup', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('cleanup() hides the section', () => {
    const { binding, q } = makeFieldSetup();
    const handler = binding.activate();
    handler(new Map([[FAKE_POLL_KEY, new Uint8Array([0])]]));
    expect(q('testSection').classList.contains('hidden')).toBe(false);
    binding.cleanup();
    expect(q('testSection').classList.contains('hidden')).toBe(true);
  });

  it('cleanup() cancels an in-flight save (no timeout error fires after)', () => {
    vi.useFakeTimers();
    const { binding, q } = makeFieldSetup();
    binding.activate();
    const select = q<HTMLSelectElement>('testSelect');
    select.value = '1';
    select.dispatchEvent(new Event('change'));
    binding.cleanup();
    vi.advanceTimersByTime(2000);
    expect(q('testStatusText').textContent).not.toBe('Save failed');
    vi.useRealTimers();
  });
});
