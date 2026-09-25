import { describe, expect, test } from 'vitest';
import { MockSmpTransport, SerialSmpTransport } from '../src/transport';
import { encodeLines } from '../src/serial-codec';

// ---------------------------------------------------------------------------
// MockSmpTransport
// ---------------------------------------------------------------------------

describe('MockSmpTransport', () => {
  test('send accumulates frames in sentFrames', async () => {
    const t = new MockSmpTransport();
    const frame1 = new Uint8Array([0x01, 0x02, 0x03]);
    const frame2 = new Uint8Array([0x04, 0x05, 0x06]);

    await t.send(frame1);
    await t.send(frame2);

    expect(t.sentFrames).toHaveLength(2);
    expect(t.sentFrames[0]).toEqual(frame1);
    expect(t.sentFrames[1]).toEqual(frame2);
  });

  test('simulateIncoming fires onFrame callback', () => {
    const t = new MockSmpTransport();
    const frame = new Uint8Array([0x0a, 0x0b, 0x0c]);

    const received: Uint8Array[] = [];
    t.onFrame((f) => received.push(f));

    t.simulateIncoming(frame);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(frame);
  });

  test('reset clears sentFrames and callback', async () => {
    const t = new MockSmpTransport();

    await t.send(new Uint8Array([0x01]));
    t.onFrame(() => {});

    t.reset();

    expect(t.sentFrames).toHaveLength(0);

    // After reset, simulateIncoming should be a no-op (no callback)
    const received: Uint8Array[] = [];
    t.simulateIncoming(new Uint8Array([0x02]));
    expect(received).toHaveLength(0);
  });

  test('connect and disconnect are no-ops', async () => {
    const t = new MockSmpTransport();
    await expect(t.connect()).resolves.toBeUndefined();
    await expect(t.disconnect()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SerialSmpTransport
// ---------------------------------------------------------------------------

/**
 * Helper: create a mock SerialPort with the given readable and writable streams.
 */
function mockPort(
  readable: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>
): SerialPort {
  return {
    open: async () => {},
    close: async () => {},
    getInfo: () => ({}),
    readable,
    writable,
  } as SerialPort;
}

/**
 * Helper: create a mock port whose readable stays open until the caller
 * closes it (used for disconnect-detection tests).
 */
function controlledPort(): {
  port: SerialPort;
  closeReadable: () => void;
} {
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const writable = new WritableStream<Uint8Array>();
  return {
    port: mockPort(readable, writable),
    closeReadable: () => ctrl!.close(),
  };
}

/**
 * Helper: create a mock port whose writable captures all written chunks
 * and whose readable closes immediately (used for send tests).
 */
function captureWritable(): {
  port: SerialPort;
  written: Uint8Array[];
} {
  const written: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
    },
  });
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
  return { port: mockPort(readable, writable), written };
}

/**
 * Helper: create a mock port whose readable emits the given Uint8Array chunks
 * (used for incoming-frame tests).
 */
function emitReadable(chunks: Uint8Array[]): {
  port: SerialPort;
} {
  const writable = new WritableStream<Uint8Array>();
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
  return { port: mockPort(readable, writable) };
}

describe('SerialSmpTransport.send', () => {
  test('encodes frame with encodeLines plus initial flush', async () => {
    const { port, written } = captureWritable();
    const transport = new SerialSmpTransport(async () => port, 115200);

    await transport.connect();

    const frame = new Uint8Array(9).fill(0x55);
    await transport.send(frame);

    // First write: \r\n flush
    expect(written).toHaveLength(2);
    expect(written[0]).toEqual(new Uint8Array([0x0d, 0x0a]));

    // Second write: encodeLines(frame)
    expect(written[1]).toEqual(encodeLines(frame));
  });

  test('flush sent only once across consecutive sends', async () => {
    const { port, written } = captureWritable();
    const transport = new SerialSmpTransport(async () => port, 115200);

    await transport.connect();

    const frame1 = new Uint8Array(9).fill(0x11);
    const frame2 = new Uint8Array(9).fill(0x22);

    await transport.send(frame1);
    await transport.send(frame2);

    // Should have exactly 3 writes: flush, frame1, frame2
    expect(written).toHaveLength(3);
    expect(written[0]).toEqual(new Uint8Array([0x0d, 0x0a]));
    expect(written[1]).toEqual(encodeLines(frame1));
    expect(written[2]).toEqual(encodeLines(frame2));

    // Flush should not appear again
  });

  test('throws if called before connect', async () => {
    const { port } = captureWritable();
    const transport = new SerialSmpTransport(async () => port, 115200);

    await expect(transport.send(new Uint8Array(9))).rejects.toThrow(
      'Transport not connected'
    );
  });

  test('throws if called after disconnect', async () => {
    const { port } = captureWritable();
    const transport = new SerialSmpTransport(async () => port, 115200);

    await transport.connect();
    await transport.disconnect();

    await expect(transport.send(new Uint8Array(9))).rejects.toThrow(
      'Transport not connected'
    );
  });
});

describe('SerialSmpTransport.incoming', () => {
  test('incoming frames delivered via onFrame', async () => {
    const frame = new Uint8Array(9).fill(0x42);
    const encoded = encodeLines(frame);

    const { port } = emitReadable([encoded]);

    const transport = new SerialSmpTransport(async () => port, 115200);

    const received: Uint8Array[] = [];
    transport.onFrame((f) => received.push(f));

    await transport.connect();

    // Wait for stream pipeline to process
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(frame);
  });

  test('non-SMP lines silently ignored', async () => {
    // A debug log line that does not start with SMP markers
    const garbage = new Uint8Array([
      0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x0a,
    ]);

    const { port } = emitReadable([garbage]);

    const transport = new SerialSmpTransport(async () => port, 115200);

    const received: Uint8Array[] = [];
    transport.onFrame((f) => received.push(f));

    await transport.connect();

    await new Promise((r) => setTimeout(r, 20));

    expect(received).toHaveLength(0);
  });
});

describe('SerialSmpTransport lifecycle', () => {
  test('connect and disconnect with mock port', async () => {
    const { port } = captureWritable();
    const transport = new SerialSmpTransport(async () => port, 115200);

    await transport.connect();
    expect(transport['_connected']).toBe(true);

    await transport.disconnect();
    expect(transport['_connected']).toBe(false);
  });

  test('disconnect is safe if not connected', async () => {
    const { port } = captureWritable();
    const transport = new SerialSmpTransport(async () => port, 115200);

    await expect(transport.disconnect()).resolves.toBeUndefined();
  });

  test('multiple connect calls are idempotent', async () => {
    const { port } = captureWritable();
    const transport = new SerialSmpTransport(async () => port, 115200);

    await transport.connect();
    await transport.connect(); // second call should be no-op
    expect(transport['_connected']).toBe(true);
  });

  test('onError fires when stream closes without disconnect() — physical unplug', async () => {
    const { port, closeReadable } = controlledPort();
    const transport = new SerialSmpTransport(async () => port, 115200);

    await transport.connect();
    expect(transport.connected).toBe(true);

    const errors: Error[] = [];
    transport.onError((err) => errors.push(err));

    // Simulate physical disconnect: port readable closes cleanly (done: true)
    // rather than throwing — matches real Web Serial behaviour on USB unplug.
    closeReadable();
    await new Promise((r) => setTimeout(r, 20));

    expect(errors).toHaveLength(1);
    expect(transport.connected).toBe(false);
  });

  test('onError does not fire on user-initiated disconnect()', async () => {
    const { port } = controlledPort();
    const transport = new SerialSmpTransport(async () => port, 115200);

    await transport.connect();

    const errors: Error[] = [];
    transport.onError((err) => errors.push(err));

    await transport.disconnect();
    await new Promise((r) => setTimeout(r, 20));

    expect(errors).toHaveLength(0);
    expect(transport.connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap tests — error paths
// ---------------------------------------------------------------------------

describe('SerialSmpTransport error paths', () => {
  test('getPort() throwing causes connect() to reject and transport stays disconnected', async () => {
    const transport = new SerialSmpTransport(async () => {
      throw new Error('port unavailable');
    }, 115200);
    await expect(transport.connect()).rejects.toThrow('port unavailable');
    expect(transport.connected).toBe(false);
  });

  test('writer.write() throwing causes send() to reject', async () => {
    // A writable whose sink always throws — models a closed or broken serial port
    const writable = new WritableStream<Uint8Array>({
      write() {
        throw new Error('serial write error');
      },
    });
    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    const port = mockPort(readable, writable);

    const transport = new SerialSmpTransport(async () => port, 115200);
    await transport.connect();

    await expect(transport.send(new Uint8Array(9))).rejects.toThrow(
      'serial write error'
    );
  });

  test('port.readable erroring fires onError with the actual error (catch branch, not done branch)', async () => {
    // ctrl.error() propagates through the TransformStream pipeline and causes
    // _reader.read() to throw, hitting the catch branch in _startReadLoop.
    // The catch branch passes the actual error to onError — not the generic
    // 'Transport disconnected' message used in the done: true branch.
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const writable = new WritableStream<Uint8Array>();
    const port = mockPort(readable, writable);

    const transport = new SerialSmpTransport(async () => port, 115200);
    const errors: Error[] = [];
    transport.onError((err) => errors.push(err));
    await transport.connect();

    ctrl.error(new Error('USB read error'));
    await new Promise((r) => setTimeout(r, 20));

    expect(transport.connected).toBe(false);
    expect(errors).toHaveLength(1);
    // catch branch: passes actual thrown error, not 'Transport disconnected'
    expect(errors[0]?.message).not.toBe('Transport disconnected');
  });
});
