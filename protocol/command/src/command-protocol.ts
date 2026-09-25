import {
  ProtocolEngine,
  type ProtocolEngineEvents,
} from '../../reliable-serial/src/protocol-engine';
import { TypedEmitter } from '../../shared/src/typed-emitter';

export type CommandProtocolEvents = {
  data: [data: Uint8Array];
  error: [error: Error];
  stateChange: [state: 'connected' | 'disconnected'];
  synced: [];
  frameToSend: [frame: Uint8Array];
  response: [group: number, cmd: number, status: number, data: Uint8Array];
};

export class CommandProtocol
  extends TypedEmitter<CommandProtocolEvents>
  implements ProtocolEngineEvents
{
  private engine: ProtocolEngine;

  constructor() {
    super();
    this.engine = new ProtocolEngine(this);
    this.engine.setOnFrameToSend((frame) => this.emit('frameToSend', frame));
  }

  public send(group: number, cmd: number, payload?: Uint8Array): void {
    this.engine.send(new Uint8Array([group, cmd, ...(payload ?? [])]));
  }

  public receiveByte(byte: number): void {
    this.engine.receiveByte(byte);
  }

  public start(): void {
    this.engine.start();
  }

  public stop(): void {
    this.engine.stop();
  }

  // ProtocolEngineEvents implementation

  onData(data: Uint8Array): void {
    this.emit('data', data);
    // Response format: [status: u8][group: u8][cmd: u8][data: 0-N bytes]
    if (data.length < 3) return;
    this.emit('response', data[1]!, data[2]!, data[0]!, data.subarray(3));
  }

  onError(error: Error): void {
    this.emit('error', error);
  }

  onStateChange(state: 'connected' | 'disconnected'): void {
    this.emit('stateChange', state);
  }

  onSynced(): void {
    this.emit('synced');
  }
}
