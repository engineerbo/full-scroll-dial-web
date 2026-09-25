import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import {
  ProtocolEngine,
  FrameID,
  ACK_DEADLINE_MS,
  MAX_TX_RETRIES,
  MAX_PAYLOAD_SIZE,
} from '../src/protocol-engine';
import { FrameCodec } from '../src/frame-codec';

const mockOnData = vi.fn();
const mockOnError = vi.fn();
const mockOnStateChange = vi.fn();
const mockOnSynced = vi.fn();

const createEvents = () => ({
  onData: mockOnData,
  onError: mockOnError,
  onStateChange: mockOnStateChange,
  onSynced: mockOnSynced,
});

// Helper: decode the first complete frame from a Uint8Array
function decodeFrame(encoded: Uint8Array): Uint8Array | null {
  const codec = new FrameCodec();
  for (const byte of encoded) {
    const result = codec.decodeByte(byte);
    if (result.status === 'ok') return result.frame;
  }
  return null;
}

// Helper: build a valid encoded frame from raw pre-CRC bytes
function buildFrame(rawBytes: number[]): Uint8Array {
  return new FrameCodec().encodeFrame(new Uint8Array(rawBytes));
}

// Helper: complete the SYNC handshake by feeding ACK_SYNC to the engine
function completeSync(engine: ProtocolEngine): void {
  buildFrame([FrameID.ACK_SYNC]).forEach((b) => engine.receiveByte(b));
}

describe('ProtocolEngine', () => {
  let engine: ProtocolEngine;

  beforeEach(() => {
    mockOnData.mockClear();
    mockOnError.mockClear();
    mockOnStateChange.mockClear();
    mockOnSynced.mockClear();
    engine = new ProtocolEngine(createEvents());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── State transitions ─────────────────────────────────────────────────────

  test('starts in disconnected state', () => {
    expect(mockOnStateChange).toHaveBeenCalledWith('disconnected');
  });

  test('can start and stop', () => {
    engine.start();
    expect(mockOnStateChange).toHaveBeenCalledWith('connected');
    engine.stop();
    expect(mockOnStateChange).toHaveBeenCalledWith('disconnected');
  });

  test('start() called twice without stop() is a no-op on the second call', () => {
    engine.start();
    mockOnStateChange.mockClear();
    engine.start();
    expect(mockOnStateChange).not.toHaveBeenCalled();
  });

  test('stop() called twice without start() is a no-op on the second call', () => {
    engine.start();
    engine.stop();
    mockOnStateChange.mockClear();
    engine.stop();
    expect(mockOnStateChange).not.toHaveBeenCalled();
  });

  // ── SYNC on start ─────────────────────────────────────────────────────────

  test('sends a SYNC frame when started', () => {
    const sent: Uint8Array[] = [];
    engine.setOnFrameToSend((f) => sent.push(f));
    engine.start();

    expect(sent).toHaveLength(1);
    const decoded = decodeFrame(sent[0]);
    expect(decoded).not.toBeNull();
    expect(decoded![0]).toBe(FrameID.SYNC);
    expect(decoded!.length).toBe(1);
  });

  // ── Send guards ───────────────────────────────────────────────────────────

  test('sending data when not connected throws', () => {
    expect(() => engine.send(new Uint8Array([1, 2, 3]))).toThrow(
      'Protocol not connected'
    );
  });

  test('sending while previous frame is pending throws', () => {
    vi.useFakeTimers();
    engine.start();
    completeSync(engine);
    engine.send(new Uint8Array([1, 2, 3]));
    expect(() => engine.send(new Uint8Array([4, 5, 6]))).toThrow(
      'Previous frame not yet acknowledged'
    );
  });

  test('sending oversized payload throws', () => {
    engine.start();
    completeSync(engine);
    expect(() => engine.send(new Uint8Array(300))).toThrow(
      'Payload size 300 exceeds maximum'
    );
  });

  test('send() with exactly MAX_PAYLOAD_SIZE bytes succeeds without throwing', () => {
    engine.start();
    completeSync(engine);
    expect(() =>
      engine.send(new Uint8Array(MAX_PAYLOAD_SIZE).fill(0x01))
    ).not.toThrow();
  });

  // ── SYNC reception ────────────────────────────────────────────────────────

  test('processes SYNC frame: resets state and clears pending send', () => {
    vi.useFakeTimers();
    engine.start();
    completeSync(engine);
    engine.send(new Uint8Array([1, 2, 3]));

    buildFrame([FrameID.SYNC]).forEach((b) => engine.receiveByte(b));

    expect(() => engine.send(new Uint8Array([4, 5, 6]))).not.toThrow();
  });

  test('SYNC frame fires onSynced', () => {
    engine.start();
    mockOnSynced.mockClear();

    buildFrame([FrameID.SYNC]).forEach((b) => engine.receiveByte(b));

    expect(mockOnSynced).toHaveBeenCalledOnce();
  });

  test('SYNC frame sends ACK_SYNC response', () => {
    const sent: Uint8Array[] = [];
    engine.setOnFrameToSend((f) => sent.push(f));
    engine.start();
    sent.length = 0; // discard initial SYNC

    buildFrame([FrameID.SYNC]).forEach((b) => engine.receiveByte(b));

    expect(sent).toHaveLength(1);
    const decoded = decodeFrame(sent[0]);
    expect(decoded).not.toBeNull();
    expect(decoded![0]).toBe(FrameID.ACK_SYNC);
    expect(decoded!.length).toBe(1);
  });

  test('SYNC with wrong length is silently dropped', () => {
    vi.useFakeTimers();
    engine.start();
    completeSync(engine);
    engine.send(new Uint8Array([1]));

    buildFrame([FrameID.SYNC, 0x00]).forEach((b) => engine.receiveByte(b));

    expect(() => engine.send(new Uint8Array([2]))).toThrow(
      'Previous frame not yet acknowledged'
    );
  });

  // ── ACK_SYNC reception ────────────────────────────────────────────────────

  test('ACK_SYNC fires onSynced', () => {
    vi.useFakeTimers();
    engine.start();
    mockOnSynced.mockClear();

    buildFrame([FrameID.ACK_SYNC]).forEach((b) => engine.receiveByte(b));

    expect(mockOnSynced).toHaveBeenCalledOnce();
  });

  test('ACK_SYNC cancels the retry timer', () => {
    vi.useFakeTimers();
    const sent: Uint8Array[] = [];
    engine.setOnFrameToSend((f) => sent.push(f));
    engine.start();
    sent.length = 0;

    buildFrame([FrameID.ACK_SYNC]).forEach((b) => engine.receiveByte(b));
    vi.advanceTimersByTime(ACK_DEADLINE_MS * (MAX_TX_RETRIES + 1) + 10);

    // No retransmissions after ACK_SYNC cancels the timer
    expect(sent).toHaveLength(0);
  });

  test('ACK_SYNC clears pending data frame', () => {
    vi.useFakeTimers();
    engine.start();
    completeSync(engine);
    engine.send(new Uint8Array([1, 2, 3]));

    // Simulate unexpected resync from device while DATA is in-flight
    buildFrame([FrameID.ACK_SYNC]).forEach((b) => engine.receiveByte(b));

    expect(() => engine.send(new Uint8Array([4, 5, 6]))).not.toThrow();
  });

  test('ACK_SYNC with wrong length is silently dropped', () => {
    vi.useFakeTimers();
    engine.start();
    mockOnSynced.mockClear();

    buildFrame([FrameID.ACK_SYNC, 0x00]).forEach((b) => engine.receiveByte(b));

    expect(mockOnSynced).not.toHaveBeenCalled();
  });

  // ── SYNC retry ────────────────────────────────────────────────────────────

  test('retransmits SYNC exactly MAX_TX_RETRIES times before calling onError', () => {
    vi.useFakeTimers();
    const sent: Uint8Array[] = [];
    engine.setOnFrameToSend((f) => sent.push(f));
    engine.start();
    // 1 initial SYNC already in sent
    vi.advanceTimersByTime(ACK_DEADLINE_MS * (MAX_TX_RETRIES + 1) + 10);

    expect(sent).toHaveLength(1 + MAX_TX_RETRIES);
    expect(mockOnError).toHaveBeenCalledOnce();
  });

  // ── ACK reception ─────────────────────────────────────────────────────────

  test('ACK matching pending seq clears pending frame', () => {
    vi.useFakeTimers();
    engine.start();
    completeSync(engine);
    engine.send(new Uint8Array([1, 2, 3]));

    // ACK for seq 0
    buildFrame([FrameID.ACK, 0x00]).forEach((b) => engine.receiveByte(b));

    expect(() => engine.send(new Uint8Array([4, 5, 6]))).not.toThrow();
  });

  test('ACK for non-matching seq is ignored', () => {
    vi.useFakeTimers();
    engine.start();
    completeSync(engine);
    engine.send(new Uint8Array([1, 2, 3]));

    // ACK for seq 1 (pending is seq 0)
    buildFrame([FrameID.ACK, 0x01]).forEach((b) => engine.receiveByte(b));

    expect(() => engine.send(new Uint8Array([4, 5, 6]))).toThrow(
      'Previous frame not yet acknowledged'
    );
  });

  test('ACK with wrong length is silently dropped', () => {
    vi.useFakeTimers();
    engine.start();
    completeSync(engine);
    engine.send(new Uint8Array([1, 2, 3]));

    // ACK-like frame with 3 raw bytes instead of 2
    buildFrame([FrameID.ACK, 0x00, 0x00]).forEach((b) => engine.receiveByte(b));

    expect(() => engine.send(new Uint8Array([4, 5, 6]))).toThrow(
      'Previous frame not yet acknowledged'
    );
  });

  // ── DATA reception ────────────────────────────────────────────────────────

  test('in-order DATA frame is delivered to application', () => {
    engine.start();

    // DATA: seq=0, payload=[0x10, 0x20]
    buildFrame([0x03, 0x00, 0x02, 0x00, 0x10, 0x20]).forEach((b) =>
      engine.receiveByte(b)
    );

    expect(mockOnData).toHaveBeenCalledOnce();
    expect(mockOnData.mock.calls[0][0]).toEqual(new Uint8Array([0x10, 0x20]));
  });

  test('DATA frame with zero-length payload is delivered to application', () => {
    engine.start();

    // DATA: seq=0, len=0, no payload bytes
    buildFrame([FrameID.DATA, 0x00, 0x00, 0x00]).forEach((b) =>
      engine.receiveByte(b)
    );

    expect(mockOnData).toHaveBeenCalledOnce();
    expect(mockOnData.mock.calls[0][0]).toEqual(new Uint8Array([]));
  });

  test('DATA frame with fewer than 4 bytes is silently dropped', () => {
    engine.start();

    // A 3-byte frame is too short to hold [FrameID, seq, len_lo, len_hi]
    buildFrame([FrameID.DATA, 0x00, 0x00]).forEach((b) =>
      engine.receiveByte(b)
    );

    expect(mockOnData).not.toHaveBeenCalled();
    expect(mockOnError).not.toHaveBeenCalled();
  });

  test('sends ACK with correct seq when DATA is received', () => {
    const sent: Uint8Array[] = [];
    engine.setOnFrameToSend((f) => sent.push(f));
    engine.start();
    sent.length = 0; // discard SYNC

    buildFrame([0x03, 0x00, 0x02, 0x00, 0x10, 0x20]).forEach((b) =>
      engine.receiveByte(b)
    );

    expect(sent).toHaveLength(1);
    const decoded = decodeFrame(sent[0]);
    expect(decoded).not.toBeNull();
    expect(decoded![0]).toBe(FrameID.ACK);
    expect(decoded![1]).toBe(0x00); // ACK for seq 0
  });

  test('future DATA frame (seq ahead of rxSeq) is silently dropped without ACK', () => {
    const sent: Uint8Array[] = [];
    engine.setOnFrameToSend((f) => sent.push(f));
    engine.start();
    sent.length = 0;

    // DATA with seq=1 (rxSeq=0, signedDelta=1 > 0 → future)
    buildFrame([0x03, 0x01, 0x02, 0x00, 0x10, 0x20]).forEach((b) =>
      engine.receiveByte(b)
    );

    expect(mockOnData).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0); // no ACK sent
  });

  test('duplicate DATA frame (seq = rxSeq-1) is re-ACKed but data not re-delivered', () => {
    const sent: Uint8Array[] = [];
    engine.setOnFrameToSend((f) => sent.push(f));
    engine.start();
    sent.length = 0;

    // Deliver seq=0 normally → rxSeq advances to 1
    buildFrame([0x03, 0x00, 0x01, 0x00, 0xab]).forEach((b) =>
      engine.receiveByte(b)
    );
    expect(mockOnData).toHaveBeenCalledOnce();
    sent.length = 0;

    // Re-send seq=0 (duplicate, signedDelta=-1 < 0)
    buildFrame([0x03, 0x00, 0x01, 0x00, 0xab]).forEach((b) =>
      engine.receiveByte(b)
    );

    expect(mockOnData).toHaveBeenCalledOnce(); // not called again
    expect(sent).toHaveLength(1); // re-ACK sent
    const decoded = decodeFrame(sent[0]);
    expect(decoded![0]).toBe(FrameID.ACK);
    expect(decoded![1]).toBe(0x00); // ACK echoes the duplicate's seq
  });

  test('duplicate at wraparound (rxSeq=0, seq=255) is re-ACKed', () => {
    const sent: Uint8Array[] = [];
    engine.setOnFrameToSend((f) => sent.push(f));
    engine.start();

    // Advance rxSeq through 0→255→0 by delivering 256 in-order frames
    for (let s = 0; s < 256; s++) {
      buildFrame([0x03, s & 0xff, 0x01, 0x00, 0x00]).forEach((b) =>
        engine.receiveByte(b)
      );
    }
    // rxSeq is back to 0; seq=255 is signedDelta=-1 < 0 → duplicate
    sent.length = 0;
    buildFrame([0x03, 0xff, 0x01, 0x00, 0x00]).forEach((b) =>
      engine.receiveByte(b)
    );

    expect(sent).toHaveLength(1);
    const decoded = decodeFrame(sent[0]);
    expect(decoded![0]).toBe(FrameID.ACK);
    expect(decoded![1]).toBe(0xff);
  });

  test('duplicate at signed boundary (signedDelta=-128) is re-ACKed', () => {
    const sent: Uint8Array[] = [];
    engine.setOnFrameToSend((f) => sent.push(f));
    engine.start();

    // Advance rxSeq to 128
    for (let s = 0; s < 128; s++) {
      buildFrame([0x03, s & 0xff, 0x01, 0x00, 0x00]).forEach((b) =>
        engine.receiveByte(b)
      );
    }
    // seq=0, rxSeq=128 → signedDelta=((0-128)&0xff)<<24>>24 = -128 < 0 → duplicate
    sent.length = 0;
    buildFrame([0x03, 0x00, 0x01, 0x00, 0x00]).forEach((b) =>
      engine.receiveByte(b)
    );

    expect(sent).toHaveLength(1);
    const decoded = decodeFrame(sent[0]);
    expect(decoded![0]).toBe(FrameID.ACK);
  });

  test('frame just inside future side (signedDelta=1) is silently dropped', () => {
    const sent: Uint8Array[] = [];
    engine.setOnFrameToSend((f) => sent.push(f));
    engine.start();
    sent.length = 0;

    // rxSeq=0, seq=1 → signedDelta=1 > 0 → drop
    buildFrame([0x03, 0x01, 0x01, 0x00, 0x00]).forEach((b) =>
      engine.receiveByte(b)
    );

    expect(mockOnData).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  test('DATA frame with payload length mismatch is silently dropped', () => {
    engine.start();

    // payloadLen says 3 but only 1 payload byte follows
    buildFrame([0x03, 0x00, 0x03, 0x00, 0xaa]).forEach((b) =>
      engine.receiveByte(b)
    );

    expect(mockOnData).not.toHaveBeenCalled();
  });

  // ── Unknown frame ID ──────────────────────────────────────────────────────

  test('unknown frame ID is silently dropped', () => {
    engine.start();

    buildFrame([0x04, 0x00]).forEach((b) => engine.receiveByte(b));

    expect(mockOnData).not.toHaveBeenCalled();
    expect(mockOnError).not.toHaveBeenCalled();
  });

  // ── Retry behaviour ───────────────────────────────────────────────────────

  test('retransmits exactly MAX_TX_RETRIES times before giving up', () => {
    vi.useFakeTimers();
    const sent: Uint8Array[] = [];
    engine.setOnFrameToSend((f) => sent.push(f));
    engine.start();
    // Complete sync handshake so the SYNC retry timer doesn't interfere
    buildFrame([FrameID.ACK_SYNC]).forEach((b) => engine.receiveByte(b));
    sent.length = 0;

    engine.send(new Uint8Array([1, 2, 3]));
    vi.advanceTimersByTime(ACK_DEADLINE_MS * (MAX_TX_RETRIES + 1) + 10);

    // 1 initial send + MAX_TX_RETRIES retransmits
    expect(sent).toHaveLength(1 + MAX_TX_RETRIES);
  });

  test('gives up after max retries and allows next send', () => {
    vi.useFakeTimers();
    engine.start();
    completeSync(engine);
    engine.send(new Uint8Array([1, 2, 3]));

    vi.advanceTimersByTime(ACK_DEADLINE_MS * (MAX_TX_RETRIES + 1) + 10);

    expect(() => engine.send(new Uint8Array([4, 5, 6]))).not.toThrow();
  });

  test('retryCount resets on next send after retry exhaustion', () => {
    vi.useFakeTimers();
    const sent: Uint8Array[] = [];
    engine.setOnFrameToSend((f) => sent.push(f));
    engine.start();
    // Complete sync handshake so the SYNC retry timer doesn't interfere
    buildFrame([FrameID.ACK_SYNC]).forEach((b) => engine.receiveByte(b));
    sent.length = 0;

    // First send — exhaust retries
    engine.send(new Uint8Array([1]));
    vi.advanceTimersByTime(ACK_DEADLINE_MS * (MAX_TX_RETRIES + 1) + 10);
    sent.length = 0;

    // Second send — should also get MAX_TX_RETRIES retransmits (retryCount was reset)
    engine.send(new Uint8Array([2]));
    vi.advanceTimersByTime(ACK_DEADLINE_MS * (MAX_TX_RETRIES + 1) + 10);

    expect(sent).toHaveLength(1 + MAX_TX_RETRIES);
  });

  // ── Sequence numbers ──────────────────────────────────────────────────────

  test('tx_seq incremented after retry exhaustion', () => {
    vi.useFakeTimers();
    const sent: Uint8Array[] = [];
    engine.setOnFrameToSend((f) => sent.push(f));
    engine.start();
    completeSync(engine);
    sent.length = 0;

    engine.send(new Uint8Array([1]));
    vi.advanceTimersByTime(ACK_DEADLINE_MS * (MAX_TX_RETRIES + 1) + 10);
    sent.length = 0;

    engine.send(new Uint8Array([2]));

    const decoded = decodeFrame(sent[0]);
    expect(decoded).not.toBeNull();
    // seq byte is at offset 1; should be 1 (0 incremented after failure)
    expect(decoded![1]).toBe(1);
  });

  test('sequence numbers wrap from 255 to 0', () => {
    vi.useFakeTimers();
    const sent: Uint8Array[] = [];
    engine.setOnFrameToSend((f) => sent.push(f));
    engine.start();
    completeSync(engine);
    sent.length = 0;

    // Simulate 256 successful send+ACK cycles to roll txSeq over
    for (let i = 0; i < 256; i++) {
      engine.send(new Uint8Array([0x01]));
      buildFrame([FrameID.ACK, i & 0xff]).forEach((b) => engine.receiveByte(b));
      sent.length = 0;
    }

    // 256 successful sends means txSeq wrapped back to 0
    engine.send(new Uint8Array([0x01]));
    const decoded = decodeFrame(sent[0]);
    expect(decoded).not.toBeNull();
    expect(decoded![1]).toBe(0); // seq wrapped to 0
  });
});
