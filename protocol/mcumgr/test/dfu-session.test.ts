import { describe, expect, test } from 'vitest';
import { encode as cborEncode, decode as cborDecode } from 'cborg';
import { encodeSmpHeader, decodeSmpHeader } from '../src/smp-header';
import { Op, Group, ImgCmd, Rc } from '../src/constants';
import { MockSmpTransport } from '../src/transport';
import { DfuSession, DfuError, type DfuProgress } from '../src/dfu-session';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tick = () => new Promise((r) => setTimeout(r, 0));

function buildResponseFrame(
  op: number,
  group: number,
  id: number,
  seq: number,
  cborPayload: Record<string, unknown>
): Uint8Array {
  const payload = cborEncode(cborPayload);
  const header = encodeSmpHeader({
    op,
    flags: 0,
    len: payload.length,
    group,
    seq,
    id,
  });
  const frame = new Uint8Array(header.length + payload.length);
  frame.set(header, 0);
  frame.set(payload, header.length);
  return frame;
}

function buildValidImage(bodySize: number): Uint8Array {
  const headerSize = 32;
  const buf = new Uint8Array(headerSize + bodySize);
  const view = new DataView(buf.buffer);

  view.setUint32(0, 0x96f3b83d, true);
  view.setUint32(4, 0x00000000, true);
  view.setUint16(8, headerSize, true);
  view.setUint16(10, 0x0000, true);
  view.setUint32(12, bodySize, true);

  buf[20] = 1;
  buf[21] = 0;
  view.setUint16(22, 0, true);
  view.setUint32(24, 0, true);

  for (let i = 0; i < bodySize; i++) buf[headerSize + i] = i & 0xff;

  return buf;
}

/** Build a "State of images" response with the given seq and slot count. */
function stateResp(seq: number, slotCount: 1 | 2): Uint8Array {
  const slot1 =
    slotCount === 2
      ? [
          {
            slot: 0,
            version: '1.0.0',
            hash: new Uint8Array(32),
            confirmed: true,
            active: true,
          },
          {
            slot: 1,
            version: '0.0.0',
            hash: new Uint8Array(32),
            confirmed: false,
            active: false,
          },
        ]
      : [
          {
            slot: 0,
            version: '1.0.0',
            hash: new Uint8Array(32),
            confirmed: true,
            active: true,
          },
        ];
  return buildResponseFrame(Op.READ_RSP, Group.IMAGE, ImgCmd.STATE, seq, {
    rc: 0,
    images: slot1,
  });
}

/** Minimal ACK for test / confirm responses. */
function ackResp(seq: number): Uint8Array {
  return buildResponseFrame(Op.WRITE_RSP, Group.IMAGE, ImgCmd.STATE, seq, {
    rc: 0,
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ERASE_OK = (seq: number) =>
  buildResponseFrame(Op.WRITE_RSP, Group.IMAGE, ImgCmd.ERASE, seq, {
    rc: 0,
  });

const UPLOAD_OK = (seq: number, off: number) =>
  buildResponseFrame(Op.WRITE_RSP, Group.IMAGE, ImgCmd.UPLOAD, seq, {
    rc: 0,
    off,
  });

/**
 * Wait for `transport.sentFrames` to reach at least `minCount` items.
 * Throws after ~200ms if the wait times out.
 */
async function waitForSentFrames(
  transport: MockSmpTransport,
  minCount: number
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (transport.sentFrames.length >= minCount) return;
    await tick();
  }
  throw new Error(
    `Timed out waiting for ${minCount} frames (got ${transport.sentFrames.length})`
  );
}

/**
 * Wait until `sentFrames` has at least `count` frames, then return the
 * last frame's decoded header.
 */
async function expectFrame(
  transport: MockSmpTransport,
  count: number
): Promise<{ frame: Uint8Array; seq: number; id: number; op: number }> {
  await waitForSentFrames(transport, count);
  const frame = transport.sentFrames[count - 1];
  const hdr = decodeSmpHeader(frame);
  return { frame, seq: hdr.seq, id: hdr.id, op: hdr.op };
}

/** Simulate a state-query response and return the next frame index. */
async function respondStateQuery(
  transport: MockSmpTransport,
  frameIdx: number,
  slotCount: 1 | 2
): Promise<number> {
  const { seq } = await expectFrame(transport, frameIdx);
  transport.simulateIncoming(stateResp(seq, slotCount));
  return frameIdx + 1;
}

/** Simulate an erase response and return the next frame index. */
async function respondErase(
  transport: MockSmpTransport,
  frameIdx: number
): Promise<number> {
  const { seq } = await expectFrame(transport, frameIdx);
  transport.simulateIncoming(ERASE_OK(seq));
  return frameIdx + 1;
}

/** Simulate an upload response and return the next frame index. */
async function respondUpload(
  transport: MockSmpTransport,
  frameIdx: number,
  off: number
): Promise<number> {
  const { seq } = await expectFrame(transport, frameIdx);
  transport.simulateIncoming(UPLOAD_OK(seq, off));
  return frameIdx + 1;
}

/** Build a "Slot info" response with the given seq and slot count. */
function slotInfoResp(seq: number, slotCount: 1 | 2): Uint8Array {
  const slots =
    slotCount === 2
      ? [
          { slot: 0, size: 262144 },
          { slot: 1, size: 262144 },
        ]
      : [{ slot: 0, size: 262144 }];
  return buildResponseFrame(Op.READ_RSP, Group.IMAGE, ImgCmd.SLOT_INFO, seq, {
    rc: 0,
    images: [{ image: 0, slots }],
  });
}

/** Simulate a Slot-Info response and return the next frame index. */
async function respondSlotInfo(
  transport: MockSmpTransport,
  frameIdx: number,
  slotCount: 1 | 2
): Promise<number> {
  const { seq } = await expectFrame(transport, frameIdx);
  transport.simulateIncoming(slotInfoResp(seq, slotCount));
  return frameIdx + 1;
}

/**
 * Simulate a Slot Info error — forces the session to fall back to state
 * queries (the path exercised by tests written before Slot Info existed).
 */
async function respondSlotInfoUnsupported(
  transport: MockSmpTransport,
  frameIdx: number
): Promise<number> {
  const { seq } = await expectFrame(transport, frameIdx);
  transport.simulateIncoming(
    buildResponseFrame(Op.READ_RSP, Group.IMAGE, ImgCmd.SLOT_INFO, seq, {
      rc: Rc.NO_ENTRY,
    })
  );
  return frameIdx + 1;
}

/** Simulate a final test/confirm response. */
async function respondFinal(
  transport: MockSmpTransport,
  frameIdx: number
): Promise<number> {
  const { seq } = await expectFrame(transport, frameIdx);
  transport.simulateIncoming(ackResp(seq));
  return frameIdx + 1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DfuSession', () => {
  test('happy path: single-chunk image (16-byte body = 48 total)', async () => {
    const image = buildValidImage(16);
    const transport = new MockSmpTransport();
    const session = new DfuSession(transport);
    const progress: DfuProgress[] = [];
    session.onProgress = (p) => progress.push({ ...p });

    const runPromise = session.run(image.buffer);

    let n = 1;
    n = await respondSlotInfoUnsupported(transport, n);
    n = await respondStateQuery(transport, n, 2);
    n = await respondErase(transport, n);
    n = await respondUpload(transport, n, 48);
    n = await respondStateQuery(transport, n, 2);
    await respondFinal(transport, n);
    await runPromise;

    expect(progress[progress.length - 1].phase).toBe('done');
    expect(progress.map((p) => p.phase)).toContain('erasing');
    expect(progress.map((p) => p.phase)).toContain('uploading');
  });

  test('happy path: multi-chunk image (224-byte body = 256 total)', async () => {
    const image = buildValidImage(224);
    const transport = new MockSmpTransport();
    const session = new DfuSession(transport);
    const progress: DfuProgress[] = [];
    session.onProgress = (p) => progress.push({ ...p });

    const runPromise = session.run(image.buffer);

    let n = 1;
    n = await respondSlotInfoUnsupported(transport, n);
    n = await respondStateQuery(transport, n, 2);
    n = await respondErase(transport, n);
    n = await respondUpload(transport, n, 90);
    n = await respondUpload(transport, n, 180);
    n = await respondUpload(transport, n, 256);
    n = await respondStateQuery(transport, n, 2);
    await respondFinal(transport, n);
    await runPromise;

    expect(progress[progress.length - 1].phase).toBe('done');
    const uploadFrames = transport.sentFrames.filter(
      (f) => decodeSmpHeader(f).id === ImgCmd.UPLOAD
    );
    expect(uploadFrames.length).toBeGreaterThanOrEqual(2);
  });

  test('first upload chunk CBOR contains len and sha fields', async () => {
    const image = buildValidImage(224);
    const transport = new MockSmpTransport();
    const session = new DfuSession(transport);

    const runPromise = session.run(image.buffer);

    let n = 1;
    n = await respondSlotInfoUnsupported(transport, n);
    n = await respondStateQuery(transport, n, 2);
    n = await respondErase(transport, n);

    // Upload chunk 1
    const { frame: frame1 } = await expectFrame(transport, n);
    const seq1 = decodeSmpHeader(frame1).seq;
    transport.simulateIncoming(UPLOAD_OK(seq1, 90));
    n++;

    // Upload chunk 2
    const { frame: frame2 } = await expectFrame(transport, n);
    const seq2 = decodeSmpHeader(frame2).seq;
    transport.simulateIncoming(UPLOAD_OK(seq2, 256));
    n++;

    n = await respondStateQuery(transport, n, 2);
    await respondFinal(transport, n);
    await runPromise;

    // First chunk CBOR should have off=0, len, sha
    const cbor0 = cborDecode(frame1.subarray(8)) as Record<string, unknown>;
    expect(cbor0.off).toBe(0);
    expect(cbor0.len).toBeTypeOf('number');
    expect(cbor0.sha).toBeInstanceOf(Uint8Array);
    expect((cbor0.sha as Uint8Array).length).toBe(32);

    // Second chunk should only have off and data
    const cbor1 = cborDecode(frame2.subarray(8)) as Record<string, unknown>;
    expect(cbor1.off).toBeGreaterThan(0);
    expect(cbor1.len).toBeUndefined();
    expect(cbor1.sha).toBeUndefined();
  });

  test('upload rc error: session rejects with DfuError', async () => {
    const image = buildValidImage(224);
    const transport = new MockSmpTransport();
    const session = new DfuSession(transport);
    const progress: DfuProgress[] = [];
    session.onProgress = (p) => progress.push({ ...p });

    const runPromise = session.run(image.buffer);

    let n = 1;
    n = await respondSlotInfoUnsupported(transport, n);
    n = await respondStateQuery(transport, n, 2);
    n = await respondErase(transport, n);

    // Upload chunk — respond with error
    const { seq } = await expectFrame(transport, n);
    transport.simulateIncoming(
      buildResponseFrame(Op.WRITE_RSP, Group.IMAGE, ImgCmd.UPLOAD, seq, {
        rc: Rc.BAD_STATE,
      })
    );

    await expect(runPromise).rejects.toThrow(DfuError);
    expect(progress.some((p) => p.phase === 'error')).toBe(true);
  });

  test('image validation failure: rejects before any send', async () => {
    const transport = new MockSmpTransport();
    const session = new DfuSession(transport);
    const invalidImage = new Uint8Array(10).buffer;

    await expect(session.run(invalidImage)).rejects.toThrow(DfuError);
    expect(transport.sentFrames).toHaveLength(0);
  });

  test('erase error: rejects before any upload', async () => {
    const image = buildValidImage(16);
    const transport = new MockSmpTransport();
    const session = new DfuSession(transport);
    const progress: DfuProgress[] = [];
    session.onProgress = (p) => progress.push({ ...p });

    const runPromise = session.run(image.buffer);

    let n = 1;
    n = await respondSlotInfoUnsupported(transport, n);
    n = await respondStateQuery(transport, n, 2);

    // Erase — respond with error
    const { seq } = await expectFrame(transport, n);
    transport.simulateIncoming(
      buildResponseFrame(Op.WRITE_RSP, Group.IMAGE, ImgCmd.ERASE, seq, {
        rc: Rc.BAD_STATE,
      })
    );

    await expect(runPromise).rejects.toThrow(DfuError);
    expect(progress.some((p) => p.phase === 'error')).toBe(true);

    const uploadFrames = transport.sentFrames.filter(
      (f) => decodeSmpHeader(f).id === ImgCmd.UPLOAD
    );
    expect(uploadFrames).toHaveLength(0);
  });

  test('session recovery: device responds with off=0, session restarts with first-chunk fields', async () => {
    const image = buildValidImage(16);
    const transport = new MockSmpTransport();
    const session = new DfuSession(transport);

    const runPromise = session.run(image.buffer);

    let n = 1;
    n = await respondSlotInfoUnsupported(transport, n);
    n = await respondStateQuery(transport, n, 2);
    n = await respondErase(transport, n);

    // Upload chunk 1 — device responds with off=0 (session lost)
    const { seq: seq1 } = await expectFrame(transport, n);
    transport.simulateIncoming(
      buildResponseFrame(Op.WRITE_RSP, Group.IMAGE, ImgCmd.UPLOAD, seq1, {
        rc: 0,
        off: 0,
      })
    );
    n++;

    // Session must restart from offset 0 with first-chunk fields (sha, len)
    const {
      frame: restartFrame,
      seq: seq2,
      id: id2,
    } = await expectFrame(transport, n);
    expect(id2).toBe(ImgCmd.UPLOAD);
    const cborRestart = cborDecode(restartFrame.subarray(8)) as Record<
      string,
      unknown
    >;
    expect(cborRestart.off).toBe(0);
    expect(cborRestart.len).toBeTypeOf('number');
    expect(cborRestart.sha).toBeInstanceOf(Uint8Array);
    expect((cborRestart.sha as Uint8Array).length).toBe(32);
    transport.simulateIncoming(UPLOAD_OK(seq2, 48));
    n++;

    // Post-DFU state query → test
    n = await respondStateQuery(transport, n, 2);
    await respondFinal(transport, n);
    await runPromise;
  });

  test('1-slot device: confirm after upload (no secondary slot)', async () => {
    const image = buildValidImage(16);
    const transport = new MockSmpTransport();
    const session = new DfuSession(transport);
    const progress: DfuProgress[] = [];
    session.onProgress = (p) => progress.push({ ...p });

    const runPromise = session.run(image.buffer);

    let n = 1;
    n = await respondSlotInfoUnsupported(transport, n);
    // Pre-DFU state query — 1 slot detected (ambiguous)
    n = await respondStateQuery(transport, n, 1);

    // Session attempts erase (ambiguous case), device says NO_EXEC
    const { seq: eraseSeq, id: eraseId } = await expectFrame(transport, n);
    expect(eraseId).toBe(ImgCmd.ERASE);
    transport.simulateIncoming(
      buildResponseFrame(Op.WRITE_RSP, Group.IMAGE, ImgCmd.ERASE, eraseSeq, {
        rc: Rc.NO_EXEC,
      })
    );
    n++;

    // Now upload
    const { seq: upSeq } = await expectFrame(transport, n);
    expect(decodeSmpHeader(transport.sentFrames[n - 1]).id).toBe(ImgCmd.UPLOAD);
    transport.simulateIncoming(UPLOAD_OK(upSeq, 48));
    n++;

    // Post-DFU state query — 1 slot still → confirm mode
    n = await respondStateQuery(transport, n, 1);

    // Final frame should be a STATE WRITE with confirm=true
    const { seq: seqFinal, op, id: idFinal } = await expectFrame(transport, n);
    expect(op).toBe(Op.WRITE);
    expect(idFinal).toBe(ImgCmd.STATE);

    // Verify confirm=true in CBOR payload
    const cbor = cborDecode(transport.sentFrames[n - 1].subarray(8)) as Record<
      string,
      unknown
    >;
    expect(cbor.confirm).toBe(true);
    expect(cbor.hash).toBeInstanceOf(Uint8Array);
    expect((cbor.hash as Uint8Array).length).toBe(32);

    transport.simulateIncoming(ackResp(seqFinal));

    await runPromise;
    expect(progress[progress.length - 1].phase).toBe('done');
  });

  // -----------------------------------------------------------------------
  // Slot Info fast path
  // -----------------------------------------------------------------------

  test('Slot Info 2-slot: erase → upload → test (no state queries)', async () => {
    const image = buildValidImage(16);
    const transport = new MockSmpTransport();
    const session = new DfuSession(transport);
    const progress: DfuProgress[] = [];
    session.onProgress = (p) => progress.push({ ...p });

    const runPromise = session.run(image.buffer);

    let n = 1;
    // Slot Info → 2 slots
    n = await respondSlotInfo(transport, n, 2);
    // Erase
    n = await respondErase(transport, n);
    // Upload
    n = await respondUpload(transport, n, 48);
    // Test (no post-DFU state query)
    const { seq: testSeq, id: testId } = await expectFrame(transport, n);
    expect(testId).toBe(ImgCmd.STATE);
    transport.simulateIncoming(ackResp(testSeq));

    await runPromise;

    expect(progress[progress.length - 1].phase).toBe('done');
    // No state-query frames should have been sent
    const stateQueries = transport.sentFrames.filter(
      (f) =>
        decodeSmpHeader(f).op === Op.READ &&
        decodeSmpHeader(f).id === ImgCmd.STATE
    );
    expect(stateQueries).toHaveLength(0);
  });

  test('Slot Info 1-slot: upload → confirm (no erase, no state queries)', async () => {
    const image = buildValidImage(16);
    const transport = new MockSmpTransport();
    const session = new DfuSession(transport);
    const progress: DfuProgress[] = [];
    session.onProgress = (p) => progress.push({ ...p });

    const runPromise = session.run(image.buffer);

    let n = 1;
    // Slot Info → 1 slot
    n = await respondSlotInfo(transport, n, 1);
    // Upload (no erase)
    n = await respondUpload(transport, n, 48);
    // Confirm (no post-DFU state query)
    const { seq: confirmSeq, id: confirmId } = await expectFrame(transport, n);
    expect(confirmId).toBe(ImgCmd.STATE);
    const cbor = cborDecode(transport.sentFrames[n - 1].subarray(8)) as Record<
      string,
      unknown
    >;
    expect(cbor.confirm).toBe(true);
    transport.simulateIncoming(ackResp(confirmSeq));

    await runPromise;

    expect(progress[progress.length - 1].phase).toBe('done');
    // No erase frame
    const hasErase = transport.sentFrames.some(
      (f) =>
        decodeSmpHeader(f).id === ImgCmd.ERASE &&
        decodeSmpHeader(f).group === Group.IMAGE
    );
    expect(hasErase).toBe(false);
    // No state-query frames
    const stateQueries = transport.sentFrames.filter(
      (f) =>
        decodeSmpHeader(f).op === Op.READ &&
        decodeSmpHeader(f).id === ImgCmd.STATE &&
        decodeSmpHeader(f).group === Group.IMAGE
    );
    expect(stateQueries).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Upload progress percentage
  // -----------------------------------------------------------------------

  test('uploading progress: percentages are non-decreasing and reach 100', async () => {
    const image = buildValidImage(224); // multi-chunk
    const transport = new MockSmpTransport();
    const session = new DfuSession(transport);
    const uploadEvents: DfuProgress[] = [];
    session.onProgress = (p) => {
      if (p.phase === 'uploading') uploadEvents.push({ ...p });
    };

    const runPromise = session.run(image.buffer);

    let n = 1;
    n = await respondSlotInfoUnsupported(transport, n);
    n = await respondStateQuery(transport, n, 2);
    n = await respondErase(transport, n);
    n = await respondUpload(transport, n, 90);
    n = await respondUpload(transport, n, 180);
    n = await respondUpload(transport, n, 256);
    n = await respondStateQuery(transport, n, 2);
    await respondFinal(transport, n);
    await runPromise;

    expect(uploadEvents.length).toBeGreaterThanOrEqual(2);
    // First event starts at 0%
    expect(uploadEvents[0].percentage).toBe(0);
    // Last event reaches 100%
    expect(uploadEvents[uploadEvents.length - 1].percentage).toBe(100);
    // All percentages are non-decreasing
    for (let i = 1; i < uploadEvents.length; i++) {
      expect(uploadEvents[i].percentage!).toBeGreaterThanOrEqual(
        uploadEvents[i - 1].percentage!
      );
    }
  });

  // -----------------------------------------------------------------------
  // Transport error during upload
  // -----------------------------------------------------------------------

  test('transport error during upload rejects run() with DfuError', async () => {
    const image = buildValidImage(16);
    const transport = new MockSmpTransport();
    const session = new DfuSession(transport);
    const progress: DfuProgress[] = [];
    session.onProgress = (p) => progress.push({ ...p });

    const runPromise = session.run(image.buffer);

    let n = 1;
    n = await respondSlotInfoUnsupported(transport, n);
    n = await respondStateQuery(transport, n, 2);
    n = await respondErase(transport, n);

    // Wait for the upload frame to be sent, then simulate a physical disconnect
    await waitForSentFrames(transport, n);
    transport.simulateError(new Error('USB device disconnected'));

    await expect(runPromise).rejects.toThrow(DfuError);
    expect(progress.some((p) => p.phase === 'error')).toBe(true);
  });
});
