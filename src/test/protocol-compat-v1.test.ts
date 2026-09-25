// @vitest-environment jsdom

/**
 * Backwards-compatibility suite for command protocol v1.
 *
 * Replays the frozen wire transcript in fixtures/protocol-v1.ts against the real
 * CommandProtocol and config panel, with only the reliable-serial engine stubbed out.
 * A failure here means a shipped v1 device would stop working with this build.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Exchange, Frame } from './fixtures/protocol-v1';
import {
  HANDSHAKE,
  GET_ALL_STATES_REQUEST,
  FULL_STATES,
  FULL_STATES_EXPECTED,
  STATES_WITH_UNKNOWN_ENTRIES,
  SET,
  SET_MIN_SENSITIVITY_REJECTED,
  SELFTEST_PASS,
  SELFTEST_MAGNET_TOO_WEAK,
} from './fixtures/protocol-v1';

// ── Simulated v1 device behind a stubbed reliable-serial engine ───────────────

const { MockEngine, device } = vi.hoisted(() => {
  const device = {
    /** Frames the app sent, in order. */
    sent: [] as number[][],
    /** Requests the device had no answer for — a v1 device would not know them. */
    unanswered: [] as number[][],
    exchanges: [] as {
      request: readonly number[];
      response: readonly number[];
    }[],
  };

  class MockEngine {
    constructor(
      private readonly events: {
        onData(data: Uint8Array): void;
        onStateChange(s: 'connected' | 'disconnected'): void;
      }
    ) {}
    setOnFrameToSend(): void {}
    receiveByte(): void {}
    start(): void {}
    stop(): void {}

    send(data: Uint8Array): void {
      const request = Array.from(data);
      device.sent.push(request);
      const match = device.exchanges.find((x) => {
        // The handshake payload is the app's own max version, so only the header is frozen
        if (x.request[0] === 0x00 && x.request[1] === 0x00) {
          return request[0] === 0x00 && request[1] === 0x00;
        }
        return (
          x.request.length === request.length &&
          x.request.every((b, i) => b === request[i])
        );
      });
      if (!match) {
        device.unanswered.push(request);
        return;
      }
      this.events.onData(new Uint8Array(match.response));
    }
  }

  return { MockEngine, device };
});

vi.mock('../../protocol/reliable-serial/src/protocol-engine', () => ({
  ProtocolEngine: MockEngine,
}));

// Import AFTER vi.mock so the stub is in effect
import { CommandProtocol } from '../../protocol/command';
import { bindConfigPanel } from '../config/index';
import type { ConnectionManager } from '../connection';
import { SENSITIVITY_DEBOUNCE_MS } from '../constants';

// ── Harness ───────────────────────────────────────────────────────────────────

function connect(...exchanges: Exchange[]) {
  device.sent = [];
  device.unanswered = [];
  device.exchanges = [HANDSHAKE, ...exchanges];

  const protocol = new CommandProtocol();
  const conn = { protocol, signal: null } as unknown as ConnectionManager;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const onInitError = vi.fn();
  const panel = bindConfigPanel(container, conn, onInitError);

  panel.prepare();
  panel.onSynced();

  const q = <T extends HTMLElement>(id: string): T =>
    container.querySelector(`#${id}`) as T;
  const hidden = (id: string): boolean => q(id).classList.contains('hidden');
  const text = (id: string): string => q(id).textContent?.trim() ?? '';

  /** Swap what the device answers to a request, e.g. to reject the next save. */
  function respondWith(exchange: Exchange): void {
    device.exchanges.unshift(exchange);
  }

  return { panel, onInitError, q, hidden, text, respondWith };
}

type Harness = ReturnType<typeof connect>;

function select(h: Harness, id: string, value: string): void {
  const el = h.q<HTMLSelectElement>(id);
  el.value = value;
  el.dispatchEvent(new Event('change'));
}

/** Drag then release, which saves immediately instead of waiting out the debounce. */
function slide(h: Harness, id: string, value: string): void {
  const el = h.q<HTMLInputElement>(id);
  el.value = value;
  el.dispatchEvent(new Event('input'));
  el.dispatchEvent(new Event('change'));
}

function lastSent(): Frame {
  return device.sent[device.sent.length - 1] ?? [];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('command protocol v1 compatibility', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  describe('handshake', () => {
    it('opens with GET_PROTOCOL_VERSION and a u16 version payload', () => {
      connect(FULL_STATES);
      const first = device.sent[0]!;
      expect(first.slice(0, 2)).toEqual([0x00, 0x00]);
      expect(first).toHaveLength(4);
    });

    it('offers at least version 1', () => {
      connect(FULL_STATES);
      const first = device.sent[0]!;
      expect(first[2]! | (first[3]! << 8)).toBeGreaterThanOrEqual(1);
    });

    it('accepts a v1 reply and starts polling with GET_ALL_STATES', () => {
      const h = connect(FULL_STATES);
      expect(device.sent[1]).toEqual(GET_ALL_STATES_REQUEST);
      expect(h.onInitError).not.toHaveBeenCalled();
      expect(h.hidden('configLoadingSection')).toBe(true);
    });

    it('only sends requests a v1 device understands', () => {
      connect(FULL_STATES);
      vi.advanceTimersByTime(5000);
      expect(device.unanswered).toEqual([]);
    });
  });

  describe('GET_ALL_STATES', () => {
    it('renders every v1 field', () => {
      const h = connect(FULL_STATES);
      const e = FULL_STATES_EXPECTED;

      expect(h.text('fwVersionValue')).toBe(e.fwVersion);
      expect(h.hidden('hwVersionRow')).toBe(true);
      expect(h.hidden('serialRow')).toBe(true);
      expect(h.q<HTMLSelectElement>('scrollModeSelect').value).toBe(
        e.scrollMode
      );
      expect(h.q<HTMLSelectElement>('buttonPressSelect').value).toBe(
        e.buttonPress
      );
      expect(h.q<HTMLSelectElement>('buttonLongpressSelect').value).toBe(
        e.buttonLongpress
      );
      expect(h.q<HTMLSelectElement>('directionSelect').value).toBe(e.direction);
      expect(h.q<HTMLInputElement>('sensitivitySlider').value).toBe(
        e.sensitivity
      );
      expect(h.q<HTMLInputElement>('minSensitivityRange').value).toBe(
        e.minSensitivity
      );
      expect(h.q<HTMLInputElement>('maxSensitivityRange').value).toBe(
        e.maxSensitivity
      );
      expect(h.text('backlashValue')).toBe(e.backlash);
    });

    it('reveals every card', () => {
      const h = connect(FULL_STATES);
      for (const id of [
        'deviceInfoSection',
        'scrollModeSection',
        'buttonPressSection',
        'buttonLongpressSection',
        'directionSection',
        'sensitivitySection',
        'sensitivityRangeSection',
        'backlashSection',
        'selfTestSection',
      ]) {
        expect(h.hidden(id), id).toBe(false);
      }
    });

    it('skips unknown entries and still reads the ones after them', () => {
      const h = connect(STATES_WITH_UNKNOWN_ENTRIES);
      expect(h.q<HTMLSelectElement>('directionSelect').value).toBe('1');
      expect(h.q<HTMLInputElement>('sensitivitySlider').value).toBe('40');
      expect(h.onInitError).not.toHaveBeenCalled();
    });
  });

  describe('SET commands', () => {
    const selects = [
      ['scrollMode', 'scrollModeSelect', 'scrollModeStatusText', '0'],
      ['buttonPress', 'buttonPressSelect', 'buttonPressStatusText', '1'],
      [
        'buttonLongpress',
        'buttonLongpressSelect',
        'buttonLongpressStatusText',
        '0',
      ],
      ['direction', 'directionSelect', 'directionStatusText', '0'],
    ] as const;

    it.each(selects)('%s sends the v1 frame', (key, id, statusId, value) => {
      const h = connect(FULL_STATES, SET[key]);
      select(h, id, value);
      expect(lastSent()).toEqual(SET[key].request);
      expect(h.text(statusId)).toBe('Saved');
    });

    const sliders = [
      ['sensitivity', 'sensitivitySlider', 'sensitivityStatusText', '50'],
      [
        'minSensitivity',
        'minSensitivityRange',
        'sensitivityRangeStatusText',
        '20',
      ],
      [
        'maxSensitivity',
        'maxSensitivityRange',
        'sensitivityRangeStatusText',
        '150',
      ],
      ['backlash', 'backlashSlider', 'backlashStatusText', '5'],
    ] as const;

    it.each(sliders)('%s sends the v1 frame', (key, id, statusId, value) => {
      const h = connect(FULL_STATES, SET[key]);
      slide(h, id, value);
      expect(lastSent()).toEqual(SET[key].request);
      expect(h.text(statusId)).toBe('Saved');
    });

    it('sends a debounced slider save as the same v1 frame', () => {
      const h = connect(FULL_STATES, SET.sensitivity);
      const el = h.q<HTMLInputElement>('sensitivitySlider');
      el.value = '50';
      el.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(SENSITIVITY_DEBOUNCE_MS);
      expect(lastSent()).toEqual(SET.sensitivity.request);
    });

    it('reports a v1 error response as a failed save', () => {
      const h = connect(FULL_STATES);
      h.respondWith(SET_MIN_SENSITIVITY_REJECTED);
      slide(h, 'minSensitivityRange', '20');
      expect(lastSent()).toEqual(SET_MIN_SENSITIVITY_REJECTED.request);
      expect(h.text('sensitivityRangeStatusText')).toBe('Save failed');
      expect(h.q<HTMLInputElement>('minSensitivityRange').value).toBe('10');
    });
  });

  describe('RUN_SELFTEST', () => {
    function runSelfTest(h: Harness): void {
      h.q<HTMLButtonElement>('selfTestRunBtn').click();
    }

    it('sends the v1 frame and shows a pass with diagnostics', () => {
      const h = connect(FULL_STATES, SELFTEST_PASS);
      runSelfTest(h);
      expect(lastSent()).toEqual(SELFTEST_PASS.request);
      expect(h.text('selfTestStatusText')).toBe('Passed');
      expect(h.text('selfTestMessage')).toBe('Self-test passed');
      expect(h.text('selfTestAgc')).toBe('64 / 128');
      expect(h.text('selfTestMagnitude')).toBe('2048');
      expect(h.text('selfTestStatusReg')).toBe('detected, in range (0x20)');
    });

    it('shows a v1 failure code with its diagnostics', () => {
      const h = connect(FULL_STATES, SELFTEST_MAGNET_TOO_WEAK);
      runSelfTest(h);
      expect(h.text('selfTestStatusText')).toBe('Failed');
      expect(h.text('selfTestMessage')).toBe('Magnet too far away (code 16)');
      expect(h.text('selfTestStatusReg')).toBe('detected, too far (0x30)');
    });
  });
});
