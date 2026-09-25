import { buildImageStateRequest, encodeLines } from '../protocol/mcumgr';
import { SERIAL_CONFIG } from '../protocol/reliable-serial';
import { CommandProtocol } from '../protocol/command';

export interface ConnectionCallbacks {
  onConnected(): void;
  onDisconnected(reason: string): void;
  onSynced(): void;
  onError(message: string): void;
  onSmpDetected(port: SerialPort): Promise<void>;
}

type ConnectedState = {
  readonly status: 'connected';
  readonly port: SerialPort;
  readonly protocol: CommandProtocol;
  readonly abort: AbortController;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly disconnectListener: (event: SerialConnectionEvent) => void;
};

type State =
  | { readonly status: 'disconnected' }
  | { readonly status: 'connecting' }
  | ConnectedState
  | { readonly status: 'disconnecting' };

export class ConnectionManager {
  private state: State = { status: 'disconnected' };

  get protocol(): CommandProtocol | null {
    return this.state.status === 'connected' ? this.state.protocol : null;
  }

  get connected(): boolean {
    return this.state.status === 'connected';
  }

  get signal(): AbortSignal | null {
    return this.state.status === 'connected' ? this.state.abort.signal : null;
  }

  constructor(private readonly callbacks: ConnectionCallbacks) {}

  async connect(): Promise<void> {
    if (this.state.status !== 'disconnected') return;
    this.state = { status: 'connecting' };

    try {
      const requestedPort = await navigator.serial.requestPort();
      await requestedPort.open({ baudRate: SERIAL_CONFIG.BAUD_RATE });

      if (await this.probeSmp(requestedPort)) {
        try {
          await this.callbacks.onSmpDetected(requestedPort);
        } finally {
          this.state = { status: 'disconnected' };
        }
        return;
      }

      const abort = new AbortController();
      const protocol = new CommandProtocol();
      const writer = requestedPort.writable.getWriter();
      const reader = requestedPort.readable.getReader();

      protocol.on('stateChange', (protocolState) => {
        if (protocolState === 'connected') {
          this.callbacks.onConnected();
        }
        // 'disconnected' is handled by disconnect() — not here
      });

      protocol.on('synced', () => {
        this.callbacks.onSynced();
      });

      protocol.on('error', (error) => {
        this.callbacks.onError(`Error — ${error.message}`);
      });

      protocol.on('frameToSend', (frame) => {
        writer.write(frame).catch(() => {
          this.callbacks.onError('Send failed');
        });
      });

      const disconnectListener = (event: SerialConnectionEvent) => {
        if (event.target === requestedPort) {
          void this.disconnect('Device disconnected');
        }
      };

      this.state = {
        status: 'connected',
        port: requestedPort,
        protocol,
        abort,
        writer,
        reader,
        disconnectListener,
      };

      void this.listenForData(reader, abort.signal, protocol);
      navigator.serial.addEventListener('disconnect', disconnectListener);
      protocol.start();
    } catch (error) {
      this.state = { status: 'disconnected' };
      throw error;
    }
  }

  async disconnect(reason: string): Promise<void> {
    if (this.state.status !== 'connected') return;
    const { port, protocol, abort, reader, writer, disconnectListener } =
      this.state;
    this.state = { status: 'disconnecting' };

    navigator.serial.removeEventListener('disconnect', disconnectListener);
    protocol.stop();
    abort.abort();

    try {
      await reader.cancel();
    } catch {
      // already closed on physical disconnect
    }

    try {
      await writer.close();
    } catch {
      // already closed on physical disconnect
    }

    try {
      await port.close();
    } catch {
      // already closed on physical disconnect
    }

    this.state = { status: 'disconnected' };
    this.callbacks.onDisconnected(reason);
  }

  private async listenForData(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
    protocol: CommandProtocol
  ): Promise<void> {
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          for (let i = 0; i < value.length; i++) {
            protocol.receiveByte(value[i]!);
          }
        }
      }
    } catch {
      // read() throws when port is physically removed or reader.cancel() is called
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // lock already released by cancel()
      }
      if (this.state.status === 'connected') {
        void this.disconnect('Device disconnected');
      }
    }
  }

  private async probeSmp(openPort: SerialPort): Promise<boolean> {
    const writer = openPort.writable.getWriter();
    const reader = openPort.readable.getReader();
    let detected = false;

    const cancelTimer = setTimeout(() => reader.cancel().catch(() => {}), 1500);

    try {
      await writer.write(new Uint8Array([0x0d, 0x0a]));
      await writer.write(encodeLines(buildImageStateRequest(0)));

      while (true) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        if (value.includes(0x06)) {
          detected = true;
          break;
        }
      }
    } catch {
      // cancelled or port error — not SMP
    } finally {
      clearTimeout(cancelTimer);
      try {
        await reader.cancel();
      } catch {
        // ignore cancel error during cleanup
      }
      try {
        reader.releaseLock();
      } catch {
        // ignore if already released
      }
      try {
        writer.releaseLock();
      } catch {
        // ignore if already released
      }
    }
    return detected;
  }
}
