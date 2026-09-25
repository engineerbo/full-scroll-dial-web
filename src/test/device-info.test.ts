// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import {
  bindDeviceInfoField,
  deviceInfoHtml,
} from '../config/fields/device-info';
import type { FieldContext } from '../config/field-utils';
import type { ConnectionManager } from '../connection';

const FW_KEY = '0-2';
const HW_KEY = '0-3';
const SERIAL_KEY = '0-4';

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeContext() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  container.innerHTML = deviceInfoHtml;

  const ctx: FieldContext = {
    container,
    conn: {} as unknown as ConnectionManager,
    getPoller: () => null,
    pollLastSeen: new Map(),
  };

  const binding = bindDeviceInfoField(ctx);

  function q<T extends Element>(id: string): T {
    return container.querySelector(`#${id}`) as T;
  }

  return { binding, q };
}

// ── poll handler ──────────────────────────────────────────────────────────────

describe('bindDeviceInfoField — poll handler', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('section stays hidden when entries map is empty', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    handler(new Map());
    expect(q('deviceInfoSection').classList.contains('hidden')).toBe(true);
  });

  it('reveals section and fw row on a valid firmware string', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    handler(new Map([[FW_KEY, utf8('1.2.3')]]));
    expect(q('deviceInfoSection').classList.contains('hidden')).toBe(false);
    expect(q('fwVersionRow').classList.contains('hidden')).toBe(false);
    expect(q('fwVersionValue').textContent).toBe('v1.2.3');
  });

  it('reveals section and hw row on a valid hardware string', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    handler(new Map([[HW_KEY, utf8('rev-B')]]));
    expect(q('deviceInfoSection').classList.contains('hidden')).toBe(false);
    expect(q('hwVersionRow').classList.contains('hidden')).toBe(false);
    expect(q('hwVersionValue').textContent).toBe('rev-B');
  });

  it('reveals section and serial row on a valid serial string', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    handler(new Map([[SERIAL_KEY, utf8('SN-00042')]]));
    expect(q('deviceInfoSection').classList.contains('hidden')).toBe(false);
    expect(q('serialRow').classList.contains('hidden')).toBe(false);
    expect(q('serialValue').textContent).toBe('SN-00042');
  });

  it('reveals all three rows when all keys are present', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    handler(
      new Map([
        [FW_KEY, utf8('1.0.0')],
        [HW_KEY, utf8('rev-A')],
        [SERIAL_KEY, utf8('ABC-123')],
      ])
    );
    expect(q('fwVersionRow').classList.contains('hidden')).toBe(false);
    expect(q('hwVersionRow').classList.contains('hidden')).toBe(false);
    expect(q('serialRow').classList.contains('hidden')).toBe(false);
  });

  it('trims leading/trailing whitespace from decoded values', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    handler(new Map([[FW_KEY, utf8('  1.0.0  ')]]));
    expect(q('fwVersionValue').textContent).toBe('v1.0.0');
  });

  it('keeps row hidden when entry bytes are empty', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    handler(new Map([[FW_KEY, new Uint8Array()]]));
    expect(q('fwVersionRow').classList.contains('hidden')).toBe(true);
    expect(q('deviceInfoSection').classList.contains('hidden')).toBe(true);
  });

  it('interprets binary version bytes as dot-separated components', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    handler(new Map([[FW_KEY, new Uint8Array([1, 2, 3])]]));
    expect(q('fwVersionRow').classList.contains('hidden')).toBe(false);
    expect(q('fwVersionValue').textContent).toBe('v1.2.3');
  });

  it('strips trailing null bytes before decoding (C-string convention)', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    handler(new Map([[FW_KEY, new Uint8Array([...utf8('1.0.0'), 0x00])]]));
    expect(q('fwVersionValue').textContent).toBe('v1.0.0');
  });

  it('shows full 3-byte binary version including trailing zero patch component', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    // v0.2.0: [major=0, minor=2, patch=0] — patch zero must not be stripped
    handler(new Map([[FW_KEY, new Uint8Array([0, 2, 0])]]));
    expect(q('fwVersionRow').classList.contains('hidden')).toBe(false);
    expect(q('fwVersionValue').textContent).toBe('v0.2.0');
  });

  it('interprets non-text bytes (e.g. 0xff 0xfe) as binary components', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    handler(new Map([[FW_KEY, new Uint8Array([0xff, 0xfe])]]));
    expect(q('fwVersionRow').classList.contains('hidden')).toBe(false);
    expect(q('fwVersionValue').textContent).toBe('v255.254');
  });

  it('keeps row hidden when decoded string is whitespace only', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    handler(new Map([[FW_KEY, utf8('   ')]]));
    expect(q('fwVersionRow').classList.contains('hidden')).toBe(true);
  });

  it('does not overwrite an already-shown value on subsequent polls', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    handler(new Map([[FW_KEY, utf8('1.0.0')]]));
    handler(new Map([[FW_KEY, utf8('9.9.9')]]));
    expect(q('fwVersionValue').textContent).toBe('v1.0.0');
  });

  it('missing keys on later polls do not hide already-shown rows', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    handler(new Map([[FW_KEY, utf8('1.0.0')]]));
    handler(new Map()); // subsequent poll with no keys
    expect(q('fwVersionRow').classList.contains('hidden')).toBe(false);
  });

  it('new activate() resets shown state so fresh values appear after reconnect', () => {
    const { binding, q } = makeContext();
    let handler = binding.activate();
    handler(new Map([[FW_KEY, utf8('1.0.0')]]));
    binding.cleanup();
    handler = binding.activate();
    handler(new Map([[FW_KEY, utf8('2.0.0')]]));
    expect(q('fwVersionValue').textContent).toBe('v2.0.0');
    expect(q('fwVersionRow').classList.contains('hidden')).toBe(false);
  });
});

// ── cleanup ───────────────────────────────────────────────────────────────────

describe('bindDeviceInfoField — cleanup', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('hides section and all rows', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    handler(
      new Map([
        [FW_KEY, utf8('1.0')],
        [HW_KEY, utf8('rev-A')],
        [SERIAL_KEY, utf8('SN-001')],
      ])
    );
    binding.cleanup();
    expect(q('deviceInfoSection').classList.contains('hidden')).toBe(true);
    expect(q('fwVersionRow').classList.contains('hidden')).toBe(true);
    expect(q('hwVersionRow').classList.contains('hidden')).toBe(true);
    expect(q('serialRow').classList.contains('hidden')).toBe(true);
  });

  it('clears text content of all value elements', () => {
    const { binding, q } = makeContext();
    const handler = binding.activate();
    handler(
      new Map([
        [FW_KEY, utf8('1.0')],
        [HW_KEY, utf8('rev-A')],
        [SERIAL_KEY, utf8('SN-001')],
      ])
    );
    binding.cleanup();
    expect(q('fwVersionValue').textContent).toBe('');
    expect(q('hwVersionValue').textContent).toBe('');
    expect(q('serialValue').textContent).toBe('');
  });
});
