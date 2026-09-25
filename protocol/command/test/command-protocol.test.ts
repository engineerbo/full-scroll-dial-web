import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ─── Shared mock class ───────────────────────────────────────────────────────
const { MockProtocolEngine, getLatestMock } = vi.hoisted(() => {
  let latest: MockEngine | null = null;

  class MockEngine {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _events: any;
    private _onFrameToSend: ((frame: Uint8Array) => void) | null = null;
    _sentData: Uint8Array[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(events: any) {
      this._events = events;
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      latest = this;
      // Real engine fires disconnected on construction — mirror that here so
      // listeners registered after construction still work correctly.
      events.onStateChange('disconnected');
    }

    setOnFrameToSend(cb: (frame: Uint8Array) => void): void {
      this._onFrameToSend = cb;
    }

    send(data: Uint8Array): void {
      this._sentData.push(new Uint8Array(data));
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    receiveByte(_b: number): void {}
    start(): void {
      this._events.onStateChange('connected');
    }
    stop(): void {
      this._events.onStateChange('disconnected');
    }

    // ── Test helpers ──────────────────────────────────────────────────────────
    /** Deliver a raw response frame [status, group, cmd, ...data] to CommandProtocol. */
    simulateFrame(frame: Uint8Array): void {
      this._events.onData(frame);
    }
    /** Trigger the protocol error callback. */
    simulateError(err: Error): void {
      this._events.onError(err);
    }
    /** Trigger the frameToSend callback. */
    simulateFrameToSend(frame: Uint8Array): void {
      this._onFrameToSend?.(frame);
    }
    /** Trigger the synced callback. */
    simulateSynced(): void {
      this._events.onSynced();
    }
    getSentData(): Uint8Array[] {
      return [...this._sentData];
    }
    clearSentData(): void {
      this._sentData = [];
    }
  }

  const MockProtocolEngine = MockEngine;
  return {
    MockProtocolEngine,
    getLatestMock: (): MockEngine => latest!,
  };
});

vi.mock('../../reliable-serial/src/protocol-engine', () => ({
  ProtocolEngine: MockProtocolEngine,
}));

// Import AFTER vi.mock so the mock is in effect.
import { CommandProtocol } from '../src/command-protocol';
import { RESPONSE_STATUS } from '../src/constants';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CommandProtocol', () => {
  let protocol: CommandProtocol;
  let mock: ReturnType<typeof getLatestMock>;

  beforeEach(() => {
    protocol = new CommandProtocol();
    mock = getLatestMock();
    protocol.start();
  });

  afterEach(() => {
    vi.useRealTimers();
    protocol.stop();
  });

  // ── 1. send() — frame construction ───────────────────────────────────────

  describe('send() — frame construction', () => {
    it('send(group, cmd) with no payload forwards [group, cmd] to underlying engine', () => {
      protocol.send(0x01, 0x02);
      expect(mock.getSentData()[0]).toEqual(new Uint8Array([0x01, 0x02]));
    });

    it('send(group, cmd, payload) forwards [group, cmd, ...payload] to underlying engine', () => {
      protocol.send(0x01, 0x03, new Uint8Array([0xaa, 0xbb]));
      expect(mock.getSentData()[0]).toEqual(
        new Uint8Array([0x01, 0x03, 0xaa, 0xbb])
      );
    });

    it('send() with a multi-byte payload preserves all payload bytes in order', () => {
      protocol.send(0x02, 0x05, new Uint8Array([0x01, 0x02, 0x03, 0x04]));
      expect(mock.getSentData()[0]).toEqual(
        new Uint8Array([0x02, 0x05, 0x01, 0x02, 0x03, 0x04])
      );
    });

    it('send() with an empty payload (zero-length Uint8Array) forwards just [group, cmd]', () => {
      protocol.send(0x01, 0x00, new Uint8Array());
      expect(mock.getSentData()[0]).toEqual(new Uint8Array([0x01, 0x00]));
    });

    it('two consecutive send() calls each forward independent frames', () => {
      protocol.send(0x01, 0x00);
      protocol.send(0x01, 0x01, new Uint8Array([0xff]));
      const sent = mock.getSentData();
      expect(sent).toHaveLength(2);
      expect(sent[0]).toEqual(new Uint8Array([0x01, 0x00]));
      expect(sent[1]).toEqual(new Uint8Array([0x01, 0x01, 0xff]));
    });

    it('send() returns void (is fire-and-forget)', () => {
      const result = protocol.send(0x01, 0x00);
      expect(result).toBeUndefined();
    });
  });

  // ── 2. 'response' event ───────────────────────────────────────────────────

  describe("'response' event", () => {
    it("emits 'response' with correct group, cmd, status, data for a valid frame", () => {
      const events: Array<[number, number, number, Uint8Array]> = [];
      protocol.on('response', (g, c, s, d) => events.push([g, c, s, d]));

      // Frame: [status=0x00, group=0x01, cmd=0x02, data=0xab]
      mock.simulateFrame(new Uint8Array([0x00, 0x01, 0x02, 0xab]));

      expect(events).toHaveLength(1);
      const [g, c, s, d] = events[0]!;
      expect(g).toBe(0x01);
      expect(c).toBe(0x02);
      expect(s).toBe(0x00);
      expect(d).toEqual(new Uint8Array([0xab]));
    });

    it("emits 'response' even when no send() was called first (unsolicited)", () => {
      const events: Array<[number, number, number, Uint8Array]> = [];
      protocol.on('response', (g, c, s, d) => events.push([g, c, s, d]));

      mock.simulateFrame(new Uint8Array([0x00, 0x02, 0x03]));

      expect(events).toHaveLength(1);
    });

    it("emits 'response' for every valid frame regardless of content", () => {
      let count = 0;
      protocol.on('response', () => {
        count++;
      });

      mock.simulateFrame(new Uint8Array([0x00, 0x01, 0x00]));
      mock.simulateFrame(new Uint8Array([0xff, 0x01, 0x01, 0x05]));
      mock.simulateFrame(new Uint8Array([0x00, 0x02, 0x07, 0x10, 0x20]));

      expect(count).toBe(3);
    });

    it("does NOT emit 'response' for a frame shorter than 3 bytes", () => {
      const events: unknown[] = [];
      protocol.on('response', (...args) => events.push(args));

      mock.simulateFrame(new Uint8Array([])); // 0 bytes
      mock.simulateFrame(new Uint8Array([0x00])); // 1 byte
      mock.simulateFrame(new Uint8Array([0x00, 0x01])); // 2 bytes

      expect(events).toHaveLength(0);
    });

    it("emits 'response' for exactly 3-byte frame with empty data", () => {
      const events: Array<[number, number, number, Uint8Array]> = [];
      protocol.on('response', (g, c, s, d) => events.push([g, c, s, d]));

      mock.simulateFrame(new Uint8Array([0x00, 0x01, 0x02]));

      expect(events).toHaveLength(1);
      expect(events[0]![3]).toEqual(new Uint8Array());
    });

    it("'response' data slice contains bytes after the first 3", () => {
      const events: Array<[number, number, number, Uint8Array]> = [];
      protocol.on('response', (g, c, s, d) => events.push([g, c, s, d]));

      mock.simulateFrame(new Uint8Array([0x00, 0x01, 0x02, 0x10, 0x20, 0x30]));

      expect(events[0]![3]).toEqual(new Uint8Array([0x10, 0x20, 0x30]));
    });

    it("'response' status byte is data[0] (the first byte of the frame)", () => {
      const statuses: number[] = [];
      protocol.on('response', (_, __, s) => statuses.push(s));

      mock.simulateFrame(new Uint8Array([RESPONSE_STATUS.SUCCESS, 0x01, 0x00]));
      mock.simulateFrame(new Uint8Array([RESPONSE_STATUS.ERROR, 0x01, 0x01]));

      expect(statuses[0]).toBe(RESPONSE_STATUS.SUCCESS);
      expect(statuses[1]).toBe(RESPONSE_STATUS.ERROR);
    });

    it("'response' group is data[1] and cmd is data[2]", () => {
      const received: Array<[number, number]> = [];
      protocol.on('response', (g, c) => received.push([g, c]));

      mock.simulateFrame(new Uint8Array([0x00, 0xaa, 0xbb]));

      expect(received[0]![0]).toBe(0xaa); // group
      expect(received[0]![1]).toBe(0xbb); // cmd
    });

    it('off() removes a listener so it no longer receives events', () => {
      const received: number[] = [];
      const listener = (g: number) => received.push(g);
      protocol.on('response', listener);
      protocol.off('response', listener);
      mock.simulateFrame(new Uint8Array([0x00, 0xab, 0xcd]));
      expect(received).toHaveLength(0);
    });

    it("multiple 'response' listeners all receive the same event", () => {
      const a: number[] = [];
      const b: number[] = [];
      protocol.on('response', (g) => a.push(g));
      protocol.on('response', (g) => b.push(g));

      mock.simulateFrame(new Uint8Array([0x00, 0x05, 0x01]));

      expect(a).toEqual([0x05]);
      expect(b).toEqual([0x05]);
    });
  });

  // ── 3. 'data' event ───────────────────────────────────────────────────────

  describe("'data' event", () => {
    it("on('data') receives the full raw response frame", () => {
      const received: Uint8Array[] = [];
      protocol.on('data', (d) => received.push(d));

      mock.simulateFrame(new Uint8Array([0x00, 0x01, 0x00, 0x42]));

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(new Uint8Array([0x00, 0x01, 0x00, 0x42]));
    });

    it("on('data') fires even for sub-3-byte frames that don't emit 'response'", () => {
      const dataReceived: Uint8Array[] = [];
      const responseReceived: unknown[] = [];
      protocol.on('data', (d) => dataReceived.push(d));
      protocol.on('response', (...args) => responseReceived.push(args));

      mock.simulateFrame(new Uint8Array([0x00, 0x01]));

      expect(dataReceived).toHaveLength(1);
      expect(responseReceived).toHaveLength(0);
    });

    it("on('data') fires before 'response' for the same frame", () => {
      const order: string[] = [];
      protocol.on('data', () => order.push('data'));
      protocol.on('response', () => order.push('response'));

      mock.simulateFrame(new Uint8Array([0x00, 0x01, 0x02]));

      expect(order).toEqual(['data', 'response']);
    });
  });

  // ── 4. Stop Behaviour ─────────────────────────────────────────────────────

  describe('Stop Behaviour', () => {
    it('stop() calls the underlying engine stop()', () => {
      const spy = vi.spyOn(mock, 'stop');
      protocol.stop();
      expect(spy).toHaveBeenCalledOnce();
    });

    it('stop() triggers the state-change callback with "disconnected"', () => {
      const states: string[] = [];
      protocol.on('stateChange', (s) => states.push(s));
      protocol.stop();
      expect(states).toContain('disconnected');
    });

    it('stop() with no pending state does not throw', () => {
      expect(() => protocol.stop()).not.toThrow();
    });

    it('stop() then send() does not throw (mock engine has no state guard)', () => {
      protocol.stop();
      expect(() => protocol.send(0x01, 0x00)).not.toThrow();
    });
  });

  // ── 5. Delegation Methods ─────────────────────────────────────────────────

  describe('Delegation Methods', () => {
    it('receiveByte() delegates the byte to the underlying engine', () => {
      const spy = vi.spyOn(mock, 'receiveByte');
      protocol.receiveByte(0x42);
      expect(spy).toHaveBeenCalledWith(0x42);
    });

    it("on('error') fires when the underlying engine emits an error", () => {
      const errors: Error[] = [];
      protocol.on('error', (e) => errors.push(e));

      const err = new Error('serial port disconnected');
      mock.simulateError(err);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe(err);
    });

    it("on('stateChange') fires on connect (start) and disconnect (stop)", () => {
      const states: string[] = [];
      const p2 = new CommandProtocol();
      p2.on('stateChange', (s) => states.push(s));
      p2.start();
      p2.stop();
      expect(states).toContain('connected');
      expect(states).toContain('disconnected');
    });

    it("on('frameToSend') fires when the engine calls setOnFrameToSend callback", () => {
      const frames: Uint8Array[] = [];
      protocol.on('frameToSend', (f) => frames.push(f));

      mock.simulateFrameToSend(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

      expect(frames).toHaveLength(1);
      expect(frames[0]).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    });

    it("on('synced') fires when the engine calls onSynced", () => {
      const synced: number[] = [];
      protocol.on('synced', () => synced.push(1));
      mock.simulateSynced();
      expect(synced).toHaveLength(1);
    });
  });
});
