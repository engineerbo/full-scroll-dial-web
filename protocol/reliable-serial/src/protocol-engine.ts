import { FrameCodec } from './frame-codec';

export const MAX_FRAME_SIZE = 256;
export const MAX_PAYLOAD_SIZE = 246;
export const MAX_TX_RETRIES = 5;
export const ACK_DEADLINE_MS = 250;

// COBS(N) = N+1 bytes for any N-byte input with no 0xFF group boundaries.
// DATA frame overhead: 1 (FrameID) + 1 (seq) + 2 (len) + 4 (CRC) = 8 bytes.
// At 255 pre-COBS bytes COBS output = 256, which trips the MAX_FRAME_SIZE guard.
// Safe ceiling: 254 pre-COBS bytes → COBS = 255 → wire (+ delimiter) = 256. ✓
// Max payload = 254 − 8 = 246.

export const FrameID = {
  SYNC: 0x00,
  ACK_SYNC: 0x01,
  ACK: 0x02,
  DATA: 0x03,
} as const;

export type FrameID = (typeof FrameID)[keyof typeof FrameID];

export interface ProtocolEngineEvents {
  onData: (data: Uint8Array) => void;
  onError: (error: Error) => void;
  onStateChange: (state: 'connected' | 'disconnected') => void;
  onSynced: () => void;
}

export class ProtocolEngine {
  private frameCodec: FrameCodec;
  private events: ProtocolEngineEvents;

  private txSeq: number = 0;
  private rxSeq: number = 0;

  private pendingFrame: Uint8Array | null = null;
  private pendingIsSyncFrame: boolean = false;
  private retryCount: number = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private state: 'connected' | 'disconnected' = 'disconnected';

  private onFrameToSend: (frame: Uint8Array) => void = () => {};

  constructor(events: ProtocolEngineEvents) {
    this.events = events;
    this.frameCodec = new FrameCodec();
    this.events.onStateChange(this.state);
  }

  public setOnFrameToSend(callback: (frame: Uint8Array) => void): void {
    this.onFrameToSend = callback;
  }

  public start(): void {
    if (this.state === 'connected') return;
    this.state = 'connected';
    this.events.onStateChange(this.state);
    this.sendSyncFrame();
  }

  public stop(): void {
    if (this.state === 'disconnected') return;
    this.state = 'disconnected';
    this.clearRetryTimer();
    this.pendingFrame = null;
    this.pendingIsSyncFrame = false;
    this.events.onStateChange(this.state);
  }

  public send(data: Uint8Array): void {
    if (this.state !== 'connected') {
      throw new Error('Protocol not connected');
    }

    if (this.pendingFrame !== null) {
      throw new Error('Previous frame not yet acknowledged');
    }

    const payloadLen = data.length;
    if (payloadLen > MAX_PAYLOAD_SIZE) {
      throw new Error(
        `Payload size ${payloadLen} exceeds maximum ${MAX_PAYLOAD_SIZE}`
      );
    }

    const seq = this.txSeq;

    const frameWithoutCrc = new Uint8Array(1 + 1 + 2 + payloadLen);
    frameWithoutCrc[0] = FrameID.DATA;
    frameWithoutCrc[1] = seq;
    frameWithoutCrc[2] = payloadLen & 0xff;
    frameWithoutCrc[3] = (payloadLen >> 8) & 0xff;
    frameWithoutCrc.set(data, 4);

    this.pendingFrame = this.frameCodec.encodeFrame(frameWithoutCrc);
    this.pendingIsSyncFrame = false;
    this.retryCount = 0;
    this.transmitFrame(this.pendingFrame);
    this.startRetryTimer();
  }

  public receiveByte(byte: number): void {
    const result = this.frameCodec.decodeByte(byte);
    if (result.status === 'ok') {
      this.processFrame(result.frame);
    }
  }

  private processFrame(frame: Uint8Array): void {
    const frameId = frame[0];

    switch (frameId) {
      case FrameID.SYNC:
        this.handleSyncFrame(frame);
        break;
      case FrameID.ACK_SYNC:
        this.handleAckSyncFrame(frame);
        break;
      case FrameID.ACK:
        this.handleAckFrame(frame);
        break;
      case FrameID.DATA:
        this.handleDataFrame(frame);
        break;
      // Unknown frame IDs are silently dropped per spec section 11
    }
  }

  private handleSyncFrame(frame: Uint8Array): void {
    // Spec: SYNC with wrong length → silently drop
    if (frame.length !== 1) return;

    this.sendAckSyncFrame();
    this.clearRetryTimer();
    this.pendingFrame = null;
    this.pendingIsSyncFrame = false;
    this.txSeq = 0;
    this.rxSeq = 0;
    this.events.onSynced();
  }

  private handleAckSyncFrame(frame: Uint8Array): void {
    // ACK_SYNC with wrong length → silently drop
    if (frame.length !== 1) return;

    this.clearRetryTimer();
    this.pendingFrame = null;
    this.pendingIsSyncFrame = false;
    this.txSeq = 0;
    this.rxSeq = 0;
    this.events.onSynced();
  }

  private handleAckFrame(frame: Uint8Array): void {
    // Spec: ACK with wrong length → silently drop
    if (frame.length !== 2) return;

    const ackSeq = frame[1];

    if (
      this.pendingFrame !== null &&
      !this.pendingIsSyncFrame &&
      ackSeq === this.txSeq
    ) {
      this.clearRetryTimer();
      this.pendingFrame = null;
      this.txSeq = (this.txSeq + 1) & 0xff;
    }
  }

  private handleDataFrame(frame: Uint8Array): void {
    if (frame.length < 4) return;

    const seq = frame[1]!;
    const payloadLen = frame[2]! | (frame[3]! << 8);

    // Spec: payload length mismatch → silently drop
    if (frame.length !== 4 + payloadLen) return;

    const payload = frame.slice(4, 4 + payloadLen);

    // Mirror the C firmware comparison: (int8_t)(seq - rx_seq)
    // Negative → seq is behind rxSeq (duplicate), Zero → in-order, Positive → future/spurious
    // The & 0xff wraps the difference into the unsigned 8-bit range, then the
    // arithmetic << 24 >> 24 sign-extends it to a signed 32-bit integer.
    const signedDelta = (((seq - this.rxSeq) & 0xff) << 24) >> 24;

    if (signedDelta === 0) {
      this.sendAckFrame(seq);
      this.rxSeq = (this.rxSeq + 1) & 0xff;
      this.events.onData(payload);
    } else if (signedDelta < 0) {
      // Duplicate frame: our previous ACK was lost — re-ACK, do not re-deliver
      this.sendAckFrame(seq);
    }
    // else signedDelta > 0: spurious/future frame — silently drop, no ACK
  }

  private sendSyncFrame(): void {
    this.pendingFrame = this.frameCodec.encodeFrame(
      new Uint8Array([FrameID.SYNC])
    );
    this.pendingIsSyncFrame = true;
    this.retryCount = 0;
    this.transmitFrame(this.pendingFrame);
    this.startRetryTimer();
  }

  private sendAckSyncFrame(): void {
    this.transmitEncodedFrame(new Uint8Array([FrameID.ACK_SYNC]));
  }

  private sendAckFrame(seq: number): void {
    this.transmitEncodedFrame(new Uint8Array([FrameID.ACK, seq & 0xff]));
  }

  private transmitEncodedFrame(data: Uint8Array): void {
    this.transmitFrame(this.frameCodec.encodeFrame(data));
  }

  private transmitFrame(frame: Uint8Array): void {
    this.onFrameToSend(frame);
  }

  private startRetryTimer(): void {
    this.clearRetryTimer();
    this.retryTimer = setTimeout(
      () => this.handleRetryTimeout(),
      ACK_DEADLINE_MS
    );
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private handleRetryTimeout(): void {
    if (this.pendingFrame === null) return;

    if (this.retryCount < MAX_TX_RETRIES) {
      this.retryCount++;
      this.transmitFrame(this.pendingFrame);
      this.startRetryTimer();
    } else {
      this.clearRetryTimer();
      this.pendingFrame = null;
      if (this.pendingIsSyncFrame) {
        this.pendingIsSyncFrame = false;
        this.events.onError(
          new Error('Sync failed: no ACK_SYNC received after max retries')
        );
      } else {
        this.txSeq = (this.txSeq + 1) & 0xff;
        this.events.onError(
          new Error('Send failed: no ACK received after max retries')
        );
      }
    }
  }
}
