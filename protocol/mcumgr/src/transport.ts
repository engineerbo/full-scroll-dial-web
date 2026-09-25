/**
 * SMP transport abstraction.
 *
 * Separates the SMP protocol layer from the physical transport.
 * `DfuSession` and `ImageCommands` program against the `SmpTransport`
 * interface and are unaware of serial framing.  Tests use `MockSmpTransport`.
 *
 * @see {@link https://docs.zephyrproject.org/latest/services/device_mgmt/smp_transport.html}
 */

import {
  encodeLines,
  createLineTransformer,
  createDeframer,
} from './serial-codec.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Transport-agnostic contract for delivering raw SMP frames.
 *
 * A "raw SMP frame" is the concatenation of the 8-byte SMP header and the
 * CBOR payload — no base64, no CRC, no length prefix.  Those details belong
 * to the transport implementation.
 */
export interface SmpTransport {
  /**
   * Send a raw SMP frame to the device.
   *
   * The implementation is responsible for all framing required by the
   * physical transport (e.g. base64 encoding, CRC, line splitting for serial).
   *
   * @param frame - Raw SMP frame (8-byte header + CBOR payload).
   */
  send(frame: Uint8Array): Promise<void>;

  /**
   * Register the callback that receives every decoded SMP frame from the
   * device.  Only one callback is active; calling again replaces it.
   *
   * @param callback - Called with each complete, framing-stripped SMP frame.
   */
  onFrame(callback: (frame: Uint8Array) => void): void;

  /**
   * Register the callback that fires when the transport encounters an
   * unrecoverable error (e.g. physical disconnect while the session is
   * active).  Only one callback is active; calling again replaces it.
   *
   * This allows callers like {@link DfuSession} to reject pending
   * `_sendAndWait` promises instead of hanging indefinitely.
   *
   * @param callback - Called with the underlying error.
   */
  onError(callback: (err: Error) => void): void;

  /**
   * Whether the transport is currently connected.
   *
   * Becomes `false` either when {@link disconnect} is called or when
   * the read loop detects a physical disconnection (before the
   * {@link onError} callback fires).  Callers can read this after
   * catching a {@link DfuSession} error to determine whether the failure
   * was transport-level or protocol-level.
   */
  readonly connected: boolean;

  /**
   * Open the transport connection.  Must be called before {@link send}.
   */
  connect(): Promise<void>;

  /**
   * Close the transport connection cleanly, releasing all resources.
   */
  disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SerialSmpTransport
// ---------------------------------------------------------------------------

/**
 * Web Serial implementation of {@link SmpTransport}.
 *
 * ## Connection lifecycle
 * 1. Call `getPort()` to obtain a `SerialPort`.
 * 2. Open the port at `baudRate` (default 115200).
 * 3. Chain `port.readable` through the TransformStream pipeline:
 *    ```
 *    port.readable → LineTransformer → ConsoleDeframer → reader loop
 *    ```
 *    Each SMP frame emitted by the deframer is delivered to the registered
 *    `onFrame` callback.
 * 4. Obtain a writer from `port.writable`.
 *
 * ## Sending frames
 * - On the first `send()` call, write `[0x0D, 0x0A]` to flush any partial
 *   input buffered in the device's line buffer.
 * - Encode the SMP frame with {@link encodeLines} and write the result.
 *
 * ## Disconnection
 * 1. Cancel the reader.
 * 2. Await both `inputStreamClosed` and `messageStreamClosed` (catching
 *    errors caused by physical disconnect).
 * 3. Close the writer.
 * 4. Close the port.
 */
export class SerialSmpTransport implements SmpTransport {
  /**
   * @param getPort - Called once during {@link connect} to obtain the
   *   `SerialPort`.  Typically wraps `navigator.serial.requestPort()`.
   * @param baudRate - UART baud rate; defaults to 115200.
   */
  constructor(
    private readonly getPort: () => Promise<SerialPort>,
    private readonly baudRate = 115200
  ) {}

  private _port: SerialPort | null = null;
  private _reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private _writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private _frameCallback: ((frame: Uint8Array) => void) | null = null;
  private _errorCallback: ((err: Error) => void) | null = null;
  private _connected = false;
  private _sentFirstFrame = false;

  /**
   * Opens the serial port and establishes the TransformStream pipeline.
   *
   * After this resolves, the transport is ready to send and the registered
   * `onFrame` callback will receive decoded SMP frames.
   */
  async connect(): Promise<void> {
    if (this._connected) return;

    const port = await this.getPort();
    await port.open({ baudRate: this.baudRate });

    const lineTransformer = createLineTransformer();
    const deframer = createDeframer();

    port.readable.pipeTo(lineTransformer.writable).catch(() => {});
    lineTransformer.readable.pipeTo(deframer.writable).catch(() => {});

    this._reader = deframer.readable.getReader();
    this._writer = port.writable.getWriter();
    this._port = port;
    this._connected = true;

    this._startReadLoop();
  }

  private async _startReadLoop(): Promise<void> {
    try {
      while (true) {
        const { value, done } = await this._reader!.read();
        if (done) break;
        this._frameCallback?.(value);
      }
    } catch (err) {
      // Reader threw — unexpected physical disconnect.
      if (this._connected) {
        this._connected = false;
        this._errorCallback?.(
          err instanceof Error ? err : new Error(String(err))
        );
      }
      return;
    }
    // Reader closed cleanly (done: true). When the USB device is physically
    // removed, port.readable errors but the .catch(() => {}) in connect()
    // swallows it — the error propagates as a stream *close* through the
    // TransformStream pipeline, so the deframer reader returns done: true
    // rather than throwing. Treat this as a physical disconnect too.
    if (this._connected) {
      this._connected = false;
      this._errorCallback?.(new Error('Transport disconnected'));
    }
  }

  /**
   * Closes the serial port and all associated streams.
   *
   * Safe to call if not connected (no-op).
   */
  async disconnect(): Promise<void> {
    this._connected = false;

    if (this._reader) {
      try {
        await this._reader.cancel();
      } catch {
        /* ignore */
      }
      this._reader = null;
    }

    if (this._writer) {
      try {
        await this._writer.close();
      } catch {
        /* ignore */
      }
      this._writer = null;
    }

    if (this._port) {
      try {
        await this._port.close();
      } catch {
        /* ignore */
      }
      this._port = null;
    }

    this._sentFirstFrame = false;
  }

  /**
   * Encodes `frame` into serial lines and writes them to the port.
   *
   * On the first call, prepends `[0x0D, 0x0A]` to flush the device's
   * line buffer.
   *
   * @param frame - Raw SMP frame (8-byte header + CBOR payload).
   */
  async send(frame: Uint8Array): Promise<void> {
    if (!this._connected) {
      throw new Error('Transport not connected');
    }

    if (!this._sentFirstFrame) {
      await this._writer!.write(new Uint8Array([0x0d, 0x0a]));
      this._sentFirstFrame = true;
    }

    await this._writer!.write(encodeLines(frame));
  }

  /**
   * Registers the callback for incoming SMP frames.
   *
   * Frames are delivered after CRC verification and framing removal by
   * the {@link createDeframer} transformer.
   */
  onFrame(callback: (frame: Uint8Array) => void): void {
    this._frameCallback = callback;
  }

  /**
   * Registers the callback for unexpected transport errors.
   *
   * Called when the read loop exits while the transport is still
   * nominally connected (e.g. USB cable unplugged during an upload).
   */
  onError(callback: (err: Error) => void): void {
    this._errorCallback = callback;
  }

  get connected(): boolean {
    return this._connected;
  }
}

// ---------------------------------------------------------------------------
// MockSmpTransport
// ---------------------------------------------------------------------------

/**
 * In-process transport for unit tests.
 *
 * Accumulates all frames passed to {@link send} in {@link sentFrames} for
 * assertion, and exposes {@link simulateIncoming} to push frames into the
 * registered `onFrame` callback — simulating device responses without any
 * serial I/O.
 *
 * @example
 * ```ts
 * const transport = new MockSmpTransport();
 * transport.onFrame(frame => { ... });
 *
 * // Trigger DFU session and simultaneously feed device responses:
 * const run = session.run(image);
 * transport.simulateIncoming(buildEraseResponse());
 * await run;
 *
 * expect(transport.sentFrames).toHaveLength(expectedCount);
 * ```
 */
export class MockSmpTransport implements SmpTransport {
  /** Every frame passed to {@link send}, in order. */
  readonly sentFrames: Uint8Array[] = [];

  private _frameCallback: ((frame: Uint8Array) => void) | null = null;
  private _errorCallback: ((err: Error) => void) | null = null;

  async send(frame: Uint8Array): Promise<void> {
    this.sentFrames.push(frame);
  }

  onFrame(callback: (frame: Uint8Array) => void): void {
    this._frameCallback = callback;
  }

  onError(callback: (err: Error) => void): void {
    this._errorCallback = callback;
  }

  get connected(): boolean {
    return true;
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  /**
   * Simulate the device sending an SMP frame to the client.
   *
   * Synchronously invokes the registered `onFrame` callback with `frame`.
   * Call this from tests to feed device responses into a running
   * `DfuSession`.
   *
   * @param frame - Raw SMP frame (8-byte header + CBOR payload).
   */
  simulateIncoming(frame: Uint8Array): void {
    this._frameCallback?.(frame);
  }

  /**
   * Simulate a transport-level error (e.g. physical disconnect).
   *
   * Synchronously invokes the registered `onError` callback with `err`.
   * Call this from tests to verify that {@link DfuSession} rejects its
   * pending promise instead of hanging.
   */
  simulateError(err: Error): void {
    this._errorCallback?.(err);
  }

  /**
   * Clears {@link sentFrames} and removes all registered callbacks.
   * Call between test cases to avoid state bleed.
   */
  reset(): void {
    this.sentFrames.length = 0;
    this._frameCallback = null;
    this._errorCallback = null;
  }
}
