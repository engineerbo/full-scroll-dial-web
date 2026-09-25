/**
 * CommandProtocol integration tests — real ProtocolEngine, no mocks.
 *
 * These tests verify that CommandProtocol correctly wires into the full
 * framing stack: send() produces COBS-encoded frames, receiveByte() decodes
 * incoming frames, and all events surface through TypedEmitter correctly.
 *
 * The file lives alongside the reliable-serial tests because it exercises
 * the byte-level framing layer end-to-end through CommandProtocol.
 */

import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { CommandProtocol } from '../../command/src/command-protocol';
import {
  FrameID,
  ACK_DEADLINE_MS,
  MAX_TX_RETRIES,
} from '../src/protocol-engine';
import { FrameCodec } from '../src/frame-codec';

/** Push a raw ACK_SYNC frame into the protocol to complete the sync handshake. */
function completeSync(protocol: CommandProtocol): void {
  const frame = new FrameCodec().encodeFrame(
    new Uint8Array([FrameID.ACK_SYNC])
  );
  frame.forEach((b) => protocol.receiveByte(b));
}

describe('CommandProtocol — integration with ProtocolEngine', () => {
  let mockOnData: ReturnType<typeof vi.fn>;
  let mockOnStateChange: ReturnType<typeof vi.fn>;
  let mockOnError: ReturnType<typeof vi.fn>;
  let mockOnSynced: ReturnType<typeof vi.fn>;
  let mockOnFrameToSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOnData = vi.fn();
    mockOnStateChange = vi.fn();
    mockOnError = vi.fn();
    mockOnSynced = vi.fn();
    mockOnFrameToSend = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createProtocol(): CommandProtocol {
    const protocol = new CommandProtocol();
    protocol.on('data', mockOnData);
    protocol.on('stateChange', mockOnStateChange);
    protocol.on('error', mockOnError);
    protocol.on('synced', mockOnSynced);
    protocol.on('frameToSend', mockOnFrameToSend);
    return protocol;
  }

  test('emits stateChange("connected") on start and stateChange("disconnected") on stop', () => {
    const protocol = createProtocol();
    protocol.start();
    expect(mockOnStateChange).toHaveBeenCalledWith('connected');

    protocol.stop();
    expect(mockOnStateChange).toHaveBeenCalledWith('disconnected');
  });

  test('start() emits frameToSend (SYNC frame) to begin the handshake', () => {
    const protocol = createProtocol();
    protocol.start();
    expect(mockOnFrameToSend).toHaveBeenCalledOnce();
  });

  test("on('synced') fires when the ACK_SYNC handshake completes", () => {
    const protocol = createProtocol();
    protocol.start();
    completeSync(protocol);
    expect(mockOnSynced).toHaveBeenCalledOnce();
  });

  test("on('data') fires with the application payload when a DATA frame is received", () => {
    const protocol = createProtocol();
    protocol.start();
    completeSync(protocol);

    // DATA: seq=0, len=1, payload=[0xAB]
    new FrameCodec()
      .encodeFrame(new Uint8Array([FrameID.DATA, 0x00, 0x01, 0x00, 0xab]))
      .forEach((b) => protocol.receiveByte(b));

    expect(mockOnData).toHaveBeenCalledOnce();
    expect(mockOnData.mock.calls[0][0]).toEqual(new Uint8Array([0xab]));
  });

  test("on('response') fires with correctly parsed fields from a DATA payload", () => {
    const protocol = createProtocol();
    const responses: Array<[number, number, number, Uint8Array]> = [];
    protocol.on('response', (g, c, s, d) => responses.push([g, c, s, d]));
    protocol.start();
    completeSync(protocol);

    // Payload: [status=0x00, group=0x01, cmd=0x02, data=0xAB]
    new FrameCodec()
      .encodeFrame(
        new Uint8Array([FrameID.DATA, 0x00, 0x04, 0x00, 0x00, 0x01, 0x02, 0xab])
      )
      .forEach((b) => protocol.receiveByte(b));

    expect(responses).toHaveLength(1);
    const [g, c, s, d] = responses[0]!;
    expect(g).toBe(0x01);
    expect(c).toBe(0x02);
    expect(s).toBe(0x00);
    expect(d).toEqual(new Uint8Array([0xab]));
  });

  test('send() produces a frame that reaches the frameToSend callback', () => {
    const protocol = createProtocol();
    protocol.start();
    completeSync(protocol);
    mockOnFrameToSend.mockClear();

    protocol.send(0x01, 0x02, new Uint8Array([0xaa]));

    expect(mockOnFrameToSend).toHaveBeenCalledOnce();
    expect(mockOnFrameToSend.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
  });

  test('send() throws when a previous frame has not yet been acknowledged', () => {
    const protocol = createProtocol();
    protocol.start();
    completeSync(protocol);

    protocol.send(0x01, 0x02, new Uint8Array([1, 2, 3]));

    expect(() => protocol.send(0x01, 0x02, new Uint8Array([4, 5, 6]))).toThrow(
      'Previous frame not yet acknowledged'
    );
  });

  test("on('error') fires when sync retry is exhausted", () => {
    vi.useFakeTimers();
    const protocol = createProtocol();
    protocol.start();
    // Do NOT call completeSync — let the SYNC frame time out

    for (let i = 0; i <= MAX_TX_RETRIES; i++) {
      vi.advanceTimersByTime(ACK_DEADLINE_MS);
    }

    expect(mockOnError).toHaveBeenCalledOnce();
    expect(mockOnError.mock.calls[0][0].message).toMatch(/Sync failed/);
  });

  test("on('error') fires when DATA send retry is exhausted", () => {
    vi.useFakeTimers();
    const protocol = createProtocol();
    protocol.start();
    completeSync(protocol);

    protocol.send(0x01, 0x02);

    for (let i = 0; i <= MAX_TX_RETRIES; i++) {
      vi.advanceTimersByTime(ACK_DEADLINE_MS);
    }

    expect(mockOnError).toHaveBeenCalledOnce();
    expect(mockOnError.mock.calls[0][0].message).toMatch(/Send failed/);
  });

  test('stop() clears pending frames and stops retries', () => {
    vi.useFakeTimers();
    const protocol = createProtocol();
    protocol.start();
    completeSync(protocol);
    protocol.send(0x01, 0x02);

    protocol.stop();

    // Advance past all retry windows — no error should fire after stop
    for (let i = 0; i <= MAX_TX_RETRIES; i++) {
      vi.advanceTimersByTime(ACK_DEADLINE_MS);
    }

    expect(mockOnError).not.toHaveBeenCalled();
  });
});
