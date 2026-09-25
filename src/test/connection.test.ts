import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionManager } from '../connection';
import type { ConnectionCallbacks } from '../connection';

// ── Mock CommandProtocol ─────────────────────────────────────────────────────
// vi.hoisted() runs before vi.mock() factories and before imports, so the class
// is available inside the factory closure despite source-level ordering.

const { MockCommandProtocol, getLatestProtocol } = vi.hoisted(() => {
  let latest: InstanceType<typeof MockCP> | null = null;

  class MockCP {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private cbs = new Map<string, (...args: any[]) => void>();

    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      latest = this;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, cb: (...args: any[]) => void): void {
      this.cbs.set(event, cb);
    }

    start(): void {
      this.cbs.get('stateChange')?.('connected');
    }

    stop(): void {
      this.cbs.get('stateChange')?.('disconnected');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    receiveByte(_b: number): void {}

    simulateSynced(): void {
      this.cbs.get('synced')?.();
    }

    simulateError(err: Error): void {
      this.cbs.get('error')?.(err);
    }

    simulateFrameToSend(frame: Uint8Array): void {
      this.cbs.get('frameToSend')?.(frame);
    }
  }

  return {
    MockCommandProtocol: MockCP,
    getLatestProtocol: () => latest!,
  };
});

// Vite resolves barrel re-exports to source files, so mock the source path.
vi.mock('../../protocol/command/src/command-protocol', () => ({
  CommandProtocol: MockCommandProtocol,
}));

// ── Mock port ────────────────────────────────────────────────────────────────

function makeMockPort() {
  const written: Uint8Array[] = [];
  const readables: ReadableStream<Uint8Array>[] = [];
  let readableIdx = 0;

  // Single shared writable; writer lock is released between probeSmp and connect.
  const writable = new WritableStream<Uint8Array>({
    write: (c) => {
      written.push(c);
    },
  });

  // Each access to `readable` returns the next pre-configured stream, matching
  // how probeSmp releases its reader before the main connect path acquires one.
  const port = {
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    get readable(): ReadableStream<Uint8Array> {
      return readables[readableIdx++]!;
    },
    get writable(): WritableStream<Uint8Array> {
      return writable;
    },
  };

  return {
    port: port as unknown as SerialPort,
    written,

    /** Closes immediately → probeSmp reads done:true → returns false (not SMP). */
    addEmptyReadable(): void {
      readables.push(
        new ReadableStream({
          start(c) {
            c.close();
          },
        })
      );
    },

    /** Enqueues `data` then closes → use to inject bytes during probeSmp. */
    addReadableWith(data: Uint8Array): void {
      readables.push(
        new ReadableStream({
          pull(c) {
            c.enqueue(data);
            c.close();
          },
        })
      );
    },

    /** Stays open until caller pushes data or closes — used for listenForData. */
    addBlockingReadable(): { push(d: Uint8Array): void; close(): void } {
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      readables.push(
        new ReadableStream({
          start(c) {
            ctrl = c;
          },
        })
      );
      return { push: (d) => ctrl.enqueue(d), close: () => ctrl.close() };
    },
  };
}

// ── Mock navigator.serial ────────────────────────────────────────────────────

function makeSerialMock(port: SerialPort) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listeners: Array<(ev: any) => void> = [];

  return {
    requestPort: vi.fn().mockResolvedValue(port),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addEventListener: vi.fn((_type: string, l: (ev: any) => void) => {
      listeners.push(l);
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    removeEventListener: vi.fn((_type: string, l: (ev: any) => void) => {
      const i = listeners.indexOf(l);
      if (i !== -1) listeners.splice(i, 1);
    }),
    simulateDisconnect(target: SerialPort): void {
      for (const l of listeners) l({ target });
    },
    get listenerCount(): number {
      return listeners.length;
    },
  };
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Wait for all pending microtasks and one event-loop turn to drain async work. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function makeCallbacks() {
  const calls = {
    connected: 0,
    disconnected: [] as string[],
    synced: 0,
    errors: [] as string[],
    smpPort: null as SerialPort | null,
  };
  const callbacks: ConnectionCallbacks = {
    onConnected: () => {
      calls.connected++;
    },
    onDisconnected: (r) => {
      calls.disconnected.push(r);
    },
    onSynced: () => {
      calls.synced++;
    },
    onError: (m) => {
      calls.errors.push(m);
    },
    onSmpDetected: async (p) => {
      calls.smpPort = p;
    },
  };
  return { callbacks, calls };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ConnectionManager', () => {
  let mockPort: ReturnType<typeof makeMockPort>;
  let serial: ReturnType<typeof makeSerialMock>;
  let calls: ReturnType<typeof makeCallbacks>['calls'];
  let conn: ConnectionManager;

  beforeEach(() => {
    mockPort = makeMockPort();
    serial = makeSerialMock(mockPort.port);
    vi.stubGlobal('navigator', { serial });
    const { callbacks, calls: c } = makeCallbacks();
    calls = c;
    conn = new ConnectionManager(callbacks);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ── 1. Config mode ────────────────────────────────────────────────────────

  describe('config mode connect', () => {
    async function connectConfigMode() {
      mockPort.addEmptyReadable(); // probeSmp: done immediately → not SMP
      mockPort.addBlockingReadable(); // listenForData: stays alive
      await conn.connect();
    }

    it('conn.connected is true after connecting', async () => {
      await connectConfigMode();
      expect(conn.connected).toBe(true);
    });

    it('conn.protocol is non-null after connecting', async () => {
      await connectConfigMode();
      expect(conn.protocol).not.toBeNull();
    });

    it('conn.signal is an AbortSignal after connecting', async () => {
      await connectConfigMode();
      expect(conn.signal).toBeInstanceOf(AbortSignal);
    });

    it('onConnected fires when the protocol emits stateChange → connected', async () => {
      await connectConfigMode();
      // MockCommandProtocol.start() fires stateChange synchronously
      expect(calls.connected).toBe(1);
    });

    it('onSynced fires when the protocol emits synced', async () => {
      await connectConfigMode();
      getLatestProtocol().simulateSynced();
      expect(calls.synced).toBe(1);
    });

    it('onError fires when the protocol emits an error', async () => {
      await connectConfigMode();
      getLatestProtocol().simulateError(new Error('framing error'));
      expect(calls.errors).toEqual(['Error — framing error']);
    });

    it('a disconnect listener is registered on navigator.serial', async () => {
      await connectConfigMode();
      expect(serial.listenerCount).toBe(1);
    });

    it('port.open() is called with the configured baud rate', async () => {
      await connectConfigMode();
      expect(mockPort.port.open).toHaveBeenCalledWith({ baudRate: 115200 });
    });
  });

  // ── 2. SMP / DFU mode detection ───────────────────────────────────────────

  describe('SMP mode detection', () => {
    it('onSmpDetected fires when 0x06 appears in the probe response', async () => {
      mockPort.addReadableWith(new Uint8Array([0x00, 0x06, 0x00]));
      await conn.connect();
      expect(calls.smpPort).not.toBeNull();
    });

    it('onSmpDetected receives the same port that was opened', async () => {
      mockPort.addReadableWith(new Uint8Array([0x06]));
      await conn.connect();
      expect(calls.smpPort).toBe(mockPort.port);
    });

    it('conn.connected is false after SMP detection (not a config connection)', async () => {
      mockPort.addReadableWith(new Uint8Array([0x06]));
      await conn.connect();
      expect(conn.connected).toBe(false);
    });

    it('onConnected is NOT called when SMP is detected', async () => {
      mockPort.addReadableWith(new Uint8Array([0x06]));
      await conn.connect();
      expect(calls.connected).toBe(0);
    });

    it('state resets to disconnected after SMP → a new connect() succeeds', async () => {
      mockPort.addReadableWith(new Uint8Array([0x06]));
      await conn.connect();

      // Second connect: new port, non-SMP probe, blocking main readable
      mockPort.addEmptyReadable();
      mockPort.addBlockingReadable();
      await conn.connect();
      expect(conn.connected).toBe(true);
    });
  });

  // ── 2b. Probe timeout (Chrome port.readable semantics) ───────────────────

  describe('SMP probe timeout', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('main reader gets a fresh stream once the timed-out probe cancel has finished', async () => {
      // Chrome keeps returning the same port.readable until the underlying cancel
      // (a receive-buffer flush) completes, and only then hands out a new stream
      vi.useFakeTimers();
      let finishFlush!: () => void;
      let current: ReadableStream<Uint8Array> | null = null;
      const streams: ReadableStream<Uint8Array>[] = [];
      const makeStream = () =>
        new ReadableStream<Uint8Array>({
          cancel: () =>
            new Promise<void>((resolve) => {
              finishFlush = () => {
                current = null;
                resolve();
              };
            }),
        });
      Object.defineProperty(mockPort.port, 'readable', {
        get: () => {
          if (!current) {
            current = makeStream();
            streams.push(current);
          }
          return current;
        },
      });

      const connecting = conn.connect();
      await vi.advanceTimersByTimeAsync(1500);
      finishFlush();
      await connecting;

      expect(streams).toHaveLength(2);
      expect(conn.connected).toBe(true);
    });
  });

  // ── 3. Disconnect ─────────────────────────────────────────────────────────

  describe('disconnect', () => {
    async function connectConfigMode() {
      mockPort.addEmptyReadable();
      mockPort.addBlockingReadable();
      await conn.connect();
    }

    it('onDisconnected fires with the given reason', async () => {
      await connectConfigMode();
      await conn.disconnect('Disconnected');
      expect(calls.disconnected).toEqual(['Disconnected']);
    });

    it('conn.connected is false after disconnect', async () => {
      await connectConfigMode();
      await conn.disconnect('Disconnected');
      expect(conn.connected).toBe(false);
    });

    it('conn.protocol is null after disconnect', async () => {
      await connectConfigMode();
      await conn.disconnect('Disconnected');
      expect(conn.protocol).toBeNull();
    });

    it('conn.signal is null after disconnect', async () => {
      await connectConfigMode();
      await conn.disconnect('Disconnected');
      expect(conn.signal).toBeNull();
    });

    it('disconnect listener is removed from navigator.serial', async () => {
      await connectConfigMode();
      expect(serial.listenerCount).toBe(1);
      await conn.disconnect('Disconnected');
      expect(serial.listenerCount).toBe(0);
    });

    it('double disconnect fires onDisconnected only once', async () => {
      await connectConfigMode();
      // First call transitions state to 'disconnecting' synchronously before any await,
      // so the concurrent second call sees a non-'connected' state and returns early.
      await Promise.all([conn.disconnect('First'), conn.disconnect('Second')]);
      expect(calls.disconnected).toHaveLength(1);
      expect(calls.disconnected[0]).toBe('First');
    });

    it('disconnect when not connected is a no-op', async () => {
      await conn.disconnect('ignored');
      expect(calls.disconnected).toHaveLength(0);
    });

    it('port.close() is called on disconnect', async () => {
      await connectConfigMode();
      await conn.disconnect('Disconnected');
      expect(mockPort.port.close).toHaveBeenCalledTimes(1);
    });
  });

  // ── 4. State machine guards ───────────────────────────────────────────────

  describe('connect guards', () => {
    it('second connect() while already connected does not open a new port', async () => {
      mockPort.addEmptyReadable();
      mockPort.addBlockingReadable();
      await conn.connect();
      await conn.connect(); // state is 'connected' → guard rejects
      expect(serial.requestPort).toHaveBeenCalledTimes(1);
    });
  });

  // ── 5. Physical disconnect ────────────────────────────────────────────────

  describe('physical disconnect', () => {
    it("stream end triggers onDisconnected with 'Device disconnected'", async () => {
      mockPort.addEmptyReadable();
      const { close } = mockPort.addBlockingReadable();
      await conn.connect();

      close(); // simulate physical port removal: stream closes unexpectedly
      await settle();

      expect(calls.disconnected).toEqual(['Device disconnected']);
      expect(conn.connected).toBe(false);
    });

    it('hardware disconnect event triggers onDisconnected', async () => {
      mockPort.addEmptyReadable();
      mockPort.addBlockingReadable();
      await conn.connect();

      serial.simulateDisconnect(mockPort.port);
      await settle();

      expect(calls.disconnected).toContain('Device disconnected');
    });
  });

  // ── 6. SMP handoff state ──────────────────────────────────────────────────

  describe('SMP handoff state', () => {
    it('second connect() called immediately after first returns early (state is connecting)', async () => {
      const { callbacks } = makeCallbacks();
      const localConn = new ConnectionManager(callbacks);

      mockPort.addReadableWith(new Uint8Array([0x06]));

      // connect() sets state = 'connecting' synchronously before its first await,
      // so a concurrent call sees a non-'disconnected' state and returns early.
      const firstConnect = localConn.connect();
      await localConn.connect(); // returns early, requestPort called only once
      expect(serial.requestPort).toHaveBeenCalledTimes(1);

      await firstConnect; // SMP probe completes, onSmpDetected resolves, finally resets state
    });

    it('onSmpDetected throwing resets state to disconnected via finally', async () => {
      const { callbacks } = makeCallbacks();
      callbacks.onSmpDetected = async () => {
        throw new Error('DFU launch failed');
      };
      const localConn = new ConnectionManager(callbacks);

      mockPort.addReadableWith(new Uint8Array([0x06]));

      // connect() propagates the error after the finally block runs
      await expect(localConn.connect()).rejects.toThrow('DFU launch failed');

      // finally block reset state to 'disconnected'
      expect(localConn.connected).toBe(false);

      // A subsequent connect() is not stuck in 'connecting'
      mockPort.addEmptyReadable();
      mockPort.addBlockingReadable();
      await localConn.connect();
      expect(localConn.connected).toBe(true);
    });
  });

  // ── 7. frameToSend write failure ─────────────────────────────────────────

  describe('frameToSend write failure', () => {
    it('writer.write() failure calls onError with "Send failed"', async () => {
      // Build a port whose writable succeeds for the first 2 writes (probeSmp
      // flush + frame) and then fails. The 3rd write comes from the protocol's
      // frameToSend event after the main connection is established.
      let writeCount = 0;
      const failWritable = new WritableStream<Uint8Array>({
        write() {
          writeCount++;
          if (writeCount > 2) throw new Error('USB write error');
        },
      });

      let readableIdx = 0;
      const readables: ReadableStream<Uint8Array>[] = [];
      readables.push(
        new ReadableStream({
          start(c) {
            c.close();
          },
        }) // probeSmp: not SMP
      );
      readables.push(
        new ReadableStream({ start() {} }) // main: stays open
      );

      const failPort = {
        open: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        get readable() {
          return readables[readableIdx++]!;
        },
        get writable() {
          return failWritable;
        },
      } as unknown as SerialPort;

      const failSerial = {
        requestPort: vi.fn().mockResolvedValue(failPort),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal('navigator', { serial: failSerial });

      const { callbacks, calls: localCalls } = makeCallbacks();
      const localConn = new ConnectionManager(callbacks);
      await localConn.connect();

      // Trigger the 3rd write via a frameToSend event → write throws → onError('Send failed')
      getLatestProtocol().simulateFrameToSend(new Uint8Array([0x01, 0x02]));
      await Promise.resolve();
      await Promise.resolve();

      expect(localCalls.errors).toContain('Send failed');
    });
  });
});
