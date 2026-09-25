// Minimal Web Serial API type declarations.
// TypeScript's bundled DOM lib does not include these yet for this version.

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: 'none' | 'even' | 'odd';
  bufferSize?: number;
  flowControl?: 'none' | 'hardware';
}

interface SerialPort {
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

interface SerialPortRequestOptions {
  filters?: SerialPortInfo[];
}

interface SerialConnectionEvent extends Event {
  readonly target: SerialPort;
}

interface Serial extends EventTarget {
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
  addEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: SerialConnectionEvent) => void
  ): void;
  removeEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: SerialConnectionEvent) => void
  ): void;
}

interface Navigator {
  readonly serial: Serial;
}
