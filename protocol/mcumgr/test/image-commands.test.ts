import { describe, expect, test, beforeAll } from 'vitest';
import { encode as cborEncode, decode as cborDecode } from 'cborg';
import { encodeSmpHeader, decodeSmpHeader } from '../src/smp-header';
import { Op, Group, ImgCmd, Rc } from '../src/constants';
import {
  SmpError,
  buildImageStateRequest,
  parseImageStateResponse,
  buildImageUploadChunk,
  parseImageUploadResponse,
  buildImageEraseRequest,
  parseImageEraseResponse,
  buildImageTestRequest,
  buildImageConfirmRequest,
  buildImageSlotInfoRequest,
  parseImageSlotInfoResponse,
  parseImageInfo,
  extractRc,
} from '../src/image-commands';

// ---------------------------------------------------------------------------
// Helper: build a response frame from header fields + CBOR payload
// ---------------------------------------------------------------------------

function buildResponse(
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

// ---------------------------------------------------------------------------
// extractRc
// ---------------------------------------------------------------------------

describe('extractRc', () => {
  test('rc=0 returns 0 (success)', () => {
    expect(extractRc({ rc: 0 })).toBe(Rc.OK);
  });

  test('rc=6 returns 6 (BAD_STATE)', () => {
    expect(extractRc({ rc: 6 })).toBe(Rc.BAD_STATE);
  });

  test('SMP v1 err format: returns err.rc', () => {
    expect(extractRc({ err: { group: 1, rc: 3 } })).toBe(Rc.IN_VAL);
  });

  test('empty map returns 0', () => {
    expect(extractRc({})).toBe(Rc.OK);
  });

  test('null rc returns 0', () => {
    expect(extractRc({ rc: null })).toBe(Rc.OK);
  });

  test('absent rc with no err returns 0', () => {
    expect(extractRc({ images: [] })).toBe(Rc.OK);
  });
});

// ---------------------------------------------------------------------------
// buildImageStateRequest
// ---------------------------------------------------------------------------

describe('buildImageStateRequest', () => {
  test('returns 9 bytes (8-byte header + 0xa0 empty map)', () => {
    const frame = buildImageStateRequest(0);
    expect(frame).toHaveLength(9);
    expect(frame[8]).toBe(0xa0); // empty CBOR map
  });

  test('header fields: op=0, group=1, id=0, len=1', () => {
    const frame = buildImageStateRequest(42);
    const hdr = decodeSmpHeader(frame);
    expect(hdr.op).toBe(Op.READ);
    expect(hdr.flags).toBe(0);
    expect(hdr.len).toBe(1);
    expect(hdr.group).toBe(Group.IMAGE);
    expect(hdr.seq).toBe(42);
    expect(hdr.id).toBe(ImgCmd.STATE);
  });

  test('len field matches payload length', () => {
    const frame = buildImageStateRequest(0);
    expect(decodeSmpHeader(frame).len).toBe(frame.length - 8);
  });
});

// ---------------------------------------------------------------------------
// buildImageUploadChunk
// ---------------------------------------------------------------------------

describe('buildImageUploadChunk', () => {
  const imageSize = 1024;
  let image: Uint8Array;
  let sha256: Uint8Array;

  beforeAll(async () => {
    image = new Uint8Array(imageSize);
    for (let i = 0; i < imageSize; i++) image[i] = i & 0xff;
    sha256 = new Uint8Array(await crypto.subtle.digest('SHA-256', image));
  });

  test('first chunk (offset=0) includes all required fields', () => {
    const frame = buildImageUploadChunk(0, 0, image, {
      mtu: 140,
      sha256,
      totalLen: imageSize,
    });

    // Header
    const hdr = decodeSmpHeader(frame);
    expect(hdr.op).toBe(Op.WRITE);
    expect(hdr.group).toBe(Group.IMAGE);
    expect(hdr.id).toBe(ImgCmd.UPLOAD);
    expect(hdr.len).toBe(frame.length - 8);

    // Total frame ≤ MTU
    expect(frame.length).toBeLessThanOrEqual(140);

    // CBOR payload
    const cbor = cborDecode(frame.subarray(8)) as Record<string, unknown>;
    expect(cbor.off).toBe(0);
    expect(cbor.data).toBeInstanceOf(Uint8Array);
    expect((cbor.data as Uint8Array).length).toBeGreaterThan(0);
    expect(cbor.len).toBe(imageSize);
    expect(cbor.sha).toEqual(sha256);
    expect(cbor.upgrade).toBeUndefined();
    expect(cbor.image).toBeUndefined();
  });

  test('continuation chunk (offset=64) has only off and data', () => {
    const frame = buildImageUploadChunk(1, 64, image, { mtu: 140 });

    const hdr = decodeSmpHeader(frame);
    expect(hdr.op).toBe(Op.WRITE);
    expect(hdr.group).toBe(Group.IMAGE);
    expect(hdr.id).toBe(ImgCmd.UPLOAD);

    const cbor = cborDecode(frame.subarray(8)) as Record<string, unknown>;
    expect(cbor.off).toBe(64);
    expect(cbor.data).toBeInstanceOf(Uint8Array);
    expect(cbor.len).toBeUndefined();
    expect(cbor.sha).toBeUndefined();
    expect(cbor.upgrade).toBeUndefined();
    expect(cbor.image).toBeUndefined();
  });

  test('chunk size respects MTU=140', () => {
    for (const offset of [0, 64]) {
      const frame = buildImageUploadChunk(0, offset, image, {
        mtu: 140,
        sha256,
        totalLen: imageSize,
      });
      expect(frame.length).toBeLessThanOrEqual(140);
    }
  });

  test('chunk size respects MTU=256', () => {
    for (const offset of [0, 64]) {
      const frame = buildImageUploadChunk(0, offset, image, {
        mtu: 256,
        sha256,
        totalLen: imageSize,
      });
      expect(frame.length).toBeLessThanOrEqual(256);
    }
  });

  test('upgrade and imageNumber at offset=0, absent on continuation', () => {
    const frame0 = buildImageUploadChunk(0, 0, image, {
      mtu: 140,
      sha256,
      totalLen: imageSize,
      upgrade: true,
      imageNumber: 1,
    });

    const cbor0 = cborDecode(frame0.subarray(8)) as Record<string, unknown>;
    expect(cbor0.upgrade).toBe(true);
    expect(cbor0.image).toBe(1);

    const frame1 = buildImageUploadChunk(1, 64, image, { mtu: 140 });
    const cbor1 = cborDecode(frame1.subarray(8)) as Record<string, unknown>;
    expect(cbor1.upgrade).toBeUndefined();
    expect(cbor1.image).toBeUndefined();
  });

  test('len field matches payload length', () => {
    const frame = buildImageUploadChunk(0, 0, image, {
      mtu: 140,
      sha256,
      totalLen: imageSize,
    });
    expect(decodeSmpHeader(frame).len).toBe(frame.length - 8);

    const frame2 = buildImageUploadChunk(1, 64, image, { mtu: 140 });
    expect(decodeSmpHeader(frame2).len).toBe(frame2.length - 8);
  });

  test('throws when sha256/totalLen missing at offset=0', () => {
    expect(() => buildImageUploadChunk(0, 0, image, { mtu: 140 })).toThrow(
      'sha256 and totalLen are required'
    );
  });
});

// ---------------------------------------------------------------------------
// parseImageUploadResponse
// ---------------------------------------------------------------------------

describe('parseImageUploadResponse', () => {
  test('success response returns nextOffset', () => {
    const frame = buildResponse(Op.WRITE_RSP, Group.IMAGE, ImgCmd.UPLOAD, 0, {
      rc: 0,
      off: 128,
    });
    const result = parseImageUploadResponse(frame);
    expect(result.nextOffset).toBe(128);
    expect(result.match).toBeUndefined();
  });

  test('response with match field', () => {
    const frame = buildResponse(Op.WRITE_RSP, Group.IMAGE, ImgCmd.UPLOAD, 0, {
      rc: 0,
      off: 1024,
      match: true,
    });
    const result = parseImageUploadResponse(frame);
    expect(result.nextOffset).toBe(1024);
    expect(result.match).toBe(true);
  });

  test('SMP v0 rc error throws SmpError', () => {
    const frame = buildResponse(Op.WRITE_RSP, Group.IMAGE, ImgCmd.UPLOAD, 0, {
      rc: Rc.BAD_STATE,
    });
    expect(() => parseImageUploadResponse(frame)).toThrow(SmpError);
    try {
      parseImageUploadResponse(frame);
    } catch (e) {
      expect((e as SmpError).rc).toBe(Rc.BAD_STATE);
    }
  });

  test('SMP v1 err format throws SmpError with correct rc', () => {
    const frame = buildResponse(Op.WRITE_RSP, Group.IMAGE, ImgCmd.UPLOAD, 0, {
      err: { group: 1, rc: Rc.IN_VAL },
    });
    expect(() => parseImageUploadResponse(frame)).toThrow(SmpError);
    try {
      parseImageUploadResponse(frame);
    } catch (e) {
      expect((e as SmpError).rc).toBe(Rc.IN_VAL);
    }
  });
});

// ---------------------------------------------------------------------------
// buildImageEraseRequest
// ---------------------------------------------------------------------------

describe('buildImageEraseRequest', () => {
  test('no slot: CBOR payload is 0xa0 (empty map), op=2, group=1, id=5', () => {
    const frame = buildImageEraseRequest(0);
    const hdr = decodeSmpHeader(frame);
    expect(hdr.op).toBe(Op.WRITE);
    expect(hdr.group).toBe(Group.IMAGE);
    expect(hdr.id).toBe(ImgCmd.ERASE);
    expect(hdr.len).toBe(frame.length - 8);

    const cbor = cborDecode(frame.subarray(8)) as Record<string, unknown>;
    expect(Object.keys(cbor)).toHaveLength(0);
  });

  test('explicit slot=0 includes slot field', () => {
    const frame = buildImageEraseRequest(0, 0);
    const cbor = cborDecode(frame.subarray(8)) as Record<string, unknown>;
    expect(cbor.slot).toBe(0);
  });

  test('explicit slot=1 includes slot field', () => {
    const frame = buildImageEraseRequest(1, 1);
    const cbor = cborDecode(frame.subarray(8)) as Record<string, unknown>;
    expect(cbor.slot).toBe(1);
  });

  test('len field matches payload length', () => {
    const frame = buildImageEraseRequest(0);
    expect(decodeSmpHeader(frame).len).toBe(frame.length - 8);
  });
});

// ---------------------------------------------------------------------------
// parseImageEraseResponse
// ---------------------------------------------------------------------------

describe('parseImageEraseResponse', () => {
  test('success response does not throw', () => {
    const frame = buildResponse(Op.WRITE_RSP, Group.IMAGE, ImgCmd.ERASE, 0, {
      rc: 0,
    });
    expect(() => parseImageEraseResponse(frame)).not.toThrow();
  });

  test('error response throws SmpError', () => {
    const frame = buildResponse(Op.WRITE_RSP, Group.IMAGE, ImgCmd.ERASE, 0, {
      rc: Rc.BAD_STATE,
    });
    expect(() => parseImageEraseResponse(frame)).toThrow(SmpError);
  });
});

// ---------------------------------------------------------------------------
// buildImageTestRequest / buildImageConfirmRequest
// ---------------------------------------------------------------------------

describe('buildImageTestRequest', () => {
  const hash = new Uint8Array(32).fill(0xab);

  test('CBOR map contains hash and confirm: false', () => {
    const frame = buildImageTestRequest(0, hash);
    const hdr = decodeSmpHeader(frame);
    expect(hdr.op).toBe(Op.WRITE);
    expect(hdr.group).toBe(Group.IMAGE);
    expect(hdr.id).toBe(ImgCmd.STATE);

    const cbor = cborDecode(frame.subarray(8)) as Record<string, unknown>;
    expect(cbor.hash).toEqual(hash);
    expect(cbor.confirm).toBe(false);
  });

  test('len field matches payload length', () => {
    const frame = buildImageTestRequest(0, hash);
    expect(decodeSmpHeader(frame).len).toBe(frame.length - 8);
  });
});

describe('buildImageConfirmRequest', () => {
  const hash = new Uint8Array(32).fill(0xcd);

  test('CBOR map contains hash and confirm: true', () => {
    const frame = buildImageConfirmRequest(7, hash);
    const hdr = decodeSmpHeader(frame);
    expect(hdr.op).toBe(Op.WRITE);
    expect(hdr.group).toBe(Group.IMAGE);
    expect(hdr.id).toBe(ImgCmd.STATE);

    const cbor = cborDecode(frame.subarray(8)) as Record<string, unknown>;
    expect(cbor.hash).toEqual(hash);
    expect(cbor.confirm).toBe(true);
  });

  test('len field matches payload length', () => {
    const frame = buildImageConfirmRequest(7, hash);
    expect(decodeSmpHeader(frame).len).toBe(frame.length - 8);
  });
});

// ---------------------------------------------------------------------------
// parseImageStateResponse
// ---------------------------------------------------------------------------

describe('parseImageStateResponse', () => {
  const slotHash = new Uint8Array(32).fill(0x42);

  test('non-empty images array', () => {
    const frame = buildResponse(Op.READ_RSP, Group.IMAGE, ImgCmd.STATE, 0, {
      rc: 0,
      images: [
        {
          slot: 0,
          version: '1.0.0',
          hash: slotHash,
          bootable: true,
          pending: false,
          confirmed: true,
          active: true,
          permanent: false,
        },
      ],
    });

    const result = parseImageStateResponse(frame);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].slot).toBe(0);
    expect(result.images[0].version).toBe('1.0.0');
    expect(result.images[0].hash).toBeInstanceOf(Uint8Array);
    expect(result.images[0].hash!.length).toBe(32);
    expect(result.images[0].bootable).toBe(true);
    expect(result.images[0].pending).toBe(false);
    expect(result.images[0].confirmed).toBe(true);
    expect(result.images[0].active).toBe(true);
    expect(result.images[0].permanent).toBe(false);
  });

  test('empty images array returns empty list', () => {
    const frame = buildResponse(Op.READ_RSP, Group.IMAGE, ImgCmd.STATE, 0, {
      rc: 0,
      images: [],
    });
    const result = parseImageStateResponse(frame);
    expect(result.images).toEqual([]);
  });

  test('rc error throws SmpError', () => {
    const frame = buildResponse(Op.READ_RSP, Group.IMAGE, ImgCmd.STATE, 0, {
      rc: Rc.NO_ENTRY,
    });
    expect(() => parseImageStateResponse(frame)).toThrow(SmpError);
    try {
      parseImageStateResponse(frame);
    } catch (e) {
      expect((e as SmpError).rc).toBe(Rc.NO_ENTRY);
    }
  });

  test('images with image field (multi-image)', () => {
    const frame = buildResponse(Op.READ_RSP, Group.IMAGE, ImgCmd.STATE, 0, {
      rc: 0,
      images: [
        { image: 0, slot: 0, version: '1.0.0', hash: slotHash },
        { image: 0, slot: 1, version: '2.0.0', hash: slotHash },
      ],
    });
    const result = parseImageStateResponse(frame);
    expect(result.images).toHaveLength(2);
    expect(result.images[0].image).toBe(0);
    expect(result.images[1].image).toBe(0);
    expect(result.images[1].slot).toBe(1);
    expect(result.images[1].version).toBe('2.0.0');
  });
});

// ---------------------------------------------------------------------------
// buildImageSlotInfoRequest
// ---------------------------------------------------------------------------

describe('buildImageSlotInfoRequest', () => {
  test('returns 9 bytes (8-byte header + 0xa0 empty map)', () => {
    const frame = buildImageSlotInfoRequest(0);
    expect(frame).toHaveLength(9);
    expect(frame[8]).toBe(0xa0);
  });

  test('header fields: op=0, group=1, id=6, len=1', () => {
    const frame = buildImageSlotInfoRequest(42);
    const hdr = decodeSmpHeader(frame);
    expect(hdr.op).toBe(Op.READ);
    expect(hdr.flags).toBe(0);
    expect(hdr.len).toBe(1);
    expect(hdr.group).toBe(Group.IMAGE);
    expect(hdr.seq).toBe(42);
    expect(hdr.id).toBe(ImgCmd.SLOT_INFO);
  });
});

// ---------------------------------------------------------------------------
// parseImageSlotInfoResponse
// ---------------------------------------------------------------------------

describe('parseImageSlotInfoResponse', () => {
  test('2-slot device: images[0].slots has 2 entries', () => {
    const frame = buildResponse(Op.READ_RSP, Group.IMAGE, ImgCmd.SLOT_INFO, 0, {
      rc: 0,
      images: [
        {
          image: 0,
          slots: [
            { slot: 0, size: 262144 },
            { slot: 1, size: 262144 },
          ],
        },
      ],
    });

    const result = parseImageSlotInfoResponse(frame);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].image).toBe(0);
    expect(result.images[0].slots).toHaveLength(2);
    expect(result.images[0].slots[0]).toEqual({ slot: 0, size: 262144 });
    expect(result.images[0].slots[1]).toEqual({ slot: 1, size: 262144 });
  });

  test('1-slot device: images[0].slots has 1 entry', () => {
    const frame = buildResponse(Op.READ_RSP, Group.IMAGE, ImgCmd.SLOT_INFO, 0, {
      rc: 0,
      images: [
        {
          image: 0,
          slots: [{ slot: 0, size: 131072 }],
        },
      ],
    });

    const result = parseImageSlotInfoResponse(frame);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].slots).toHaveLength(1);
    expect(result.images[0].slots[0].slot).toBe(0);
    expect(result.images[0].slots[0].size).toBe(131072);
  });

  test('error rc throws SmpError', () => {
    const frame = buildResponse(Op.READ_RSP, Group.IMAGE, ImgCmd.SLOT_INFO, 0, {
      rc: Rc.NO_ENTRY,
    });
    expect(() => parseImageSlotInfoResponse(frame)).toThrow(SmpError);
    try {
      parseImageSlotInfoResponse(frame);
    } catch (e) {
      expect((e as SmpError).rc).toBe(Rc.NO_ENTRY);
    }
  });

  test('optional upload_image_id field', () => {
    const frame = buildResponse(Op.READ_RSP, Group.IMAGE, ImgCmd.SLOT_INFO, 0, {
      rc: 0,
      images: [
        {
          image: 0,
          slots: [
            { slot: 0, size: 262144, upload_image_id: 7 },
            { slot: 1, size: 262144, upload_image_id: 8 },
          ],
        },
      ],
    });

    const result = parseImageSlotInfoResponse(frame);
    expect(result.images[0].slots[0].uploadImageId).toBe(7);
    expect(result.images[0].slots[1].uploadImageId).toBe(8);
  });

  test('optional max_image_size field', () => {
    const frame = buildResponse(Op.READ_RSP, Group.IMAGE, ImgCmd.SLOT_INFO, 0, {
      rc: 0,
      images: [
        {
          image: 0,
          slots: [{ slot: 0, size: 262144 }],
          max_image_size: 524288,
        },
      ],
    });

    const result = parseImageSlotInfoResponse(frame);
    expect(result.images[0].maxImageSize).toBe(524288);
  });
});

// ---------------------------------------------------------------------------
// parseImageInfo
// ---------------------------------------------------------------------------

describe('parseImageInfo', () => {
  function buildValidImage(
    overrides?: Partial<{
      magic: number;
      loadAddr: number;
      headerSize: number;
      protectedTlv: number;
      imageSize: number;
      major: number;
      minor: number;
      revision: number;
      build: number;
    }>
  ): ArrayBuffer {
    const hdrSize = overrides?.headerSize ?? 32;
    const imgSize = overrides?.imageSize ?? 64;
    const buf = new Uint8Array(hdrSize + imgSize);
    const view = new DataView(buf.buffer);

    view.setUint32(0, overrides?.magic ?? 0x96f3b83d, true);
    view.setUint32(4, overrides?.loadAddr ?? 0x00000000, true);
    view.setUint16(8, hdrSize, true);
    view.setUint16(10, overrides?.protectedTlv ?? 0x0000, true);
    view.setUint32(12, imgSize, true);

    buf[20] = overrides?.major ?? 1;
    buf[21] = overrides?.minor ?? 2;
    view.setUint16(22, overrides?.revision ?? 3, true);
    view.setUint32(24, overrides?.build ?? 4, true);

    return buf.buffer;
  }

  test('valid image returns correct metadata', async () => {
    const info = await parseImageInfo(buildValidImage());
    expect(info.imageSize).toBe(64);
    expect(info.version).toBe('1.2.3+4');
    expect(info.sha256).toBeInstanceOf(Uint8Array);
    expect(info.sha256.length).toBe(32);
  });

  test('sha256 matches crypto.subtle.digest over header+body only', async () => {
    const buf = buildValidImage();
    const imageArr = new Uint8Array(buf);
    // header=32, body=64 → slice covers exactly the meaningful bytes
    const expectedHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', imageArr.slice(0, 64 + 32))
    );
    const info = await parseImageInfo(buf);
    expect(info.sha256).toEqual(expectedHash);
  });

  test('sha256 covers header+body only, not trailing TLV bytes', async () => {
    // Build a valid 96-byte image then append 32 bytes of fake TLV data.
    const base = new Uint8Array(buildValidImage()); // 96 bytes
    const withTlv = new Uint8Array(base.length + 32);
    withTlv.set(base);
    withTlv.fill(0xff, base.length); // fake TLV trailer

    const expectedHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', withTlv.slice(0, 64 + 32))
    );
    const fullBufferHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', withTlv)
    );

    const info = await parseImageInfo(withTlv.buffer);
    // SHA must cover only header+body, not TLV — these should differ
    expect(expectedHash).not.toEqual(fullBufferHash);
    expect(info.sha256).toEqual(expectedHash);
    expect(info.sha256).not.toEqual(fullBufferHash);
  });

  test('throws on too-short file', async () => {
    const buf = new Uint8Array(10).buffer;
    await expect(parseImageInfo(buf)).rejects.toThrow('too short');
  });

  test('throws on wrong magic bytes', async () => {
    await expect(
      parseImageInfo(buildValidImage({ magic: 0xdeadbeef }))
    ).rejects.toThrow('wrong magic bytes');
  });

  test('throws on wrong load address', async () => {
    await expect(
      parseImageInfo(buildValidImage({ loadAddr: 0x00000001 }))
    ).rejects.toThrow('wrong load address');
  });

  test('throws when image size exceeds buffer', async () => {
    // Build a valid 64-byte image then patch the declared size to exceed the buffer
    const buf = buildValidImage({ imageSize: 64 });
    const view = new DataView(buf);
    view.setUint32(12, 9999, true);
    await expect(parseImageInfo(buf)).rejects.toThrow('wrong image size');
  });

  test('throws on non-zero protected TLV', async () => {
    await expect(
      parseImageInfo(buildValidImage({ protectedTlv: 0x0001 }))
    ).rejects.toThrow('wrong protected TLV');
  });

  test('version string format: major.minor.revision+build', async () => {
    const info = await parseImageInfo(
      buildValidImage({
        major: 255,
        minor: 0,
        revision: 65535,
        build: 4294967295,
      })
    );
    expect(info.version).toBe('255.0.65535+4294967295');
  });
});

// ---------------------------------------------------------------------------
// SMP len field integrity — every built request
// ---------------------------------------------------------------------------

describe('SMP len field integrity', () => {
  test('buildImageStateRequest: len === payload length', () => {
    for (const seq of [0, 1, 255]) {
      const frame = buildImageStateRequest(seq);
      expect(decodeSmpHeader(frame).len).toBe(frame.length - 8);
    }
  });

  test('buildImageUploadChunk: len === payload length', () => {
    const image = new Uint8Array(100);
    const sha256 = new Uint8Array(32);
    const frame0 = buildImageUploadChunk(0, 0, image, {
      mtu: 140,
      sha256,
      totalLen: 100,
    });
    expect(decodeSmpHeader(frame0).len).toBe(frame0.length - 8);

    const frame1 = buildImageUploadChunk(1, 50, image, { mtu: 140 });
    expect(decodeSmpHeader(frame1).len).toBe(frame1.length - 8);
  });

  test('buildImageSlotInfoRequest: len === payload length', () => {
    const frame = buildImageSlotInfoRequest(0);
    expect(decodeSmpHeader(frame).len).toBe(frame.length - 8);
  });

  test('buildImageEraseRequest: len === payload length', () => {
    const frame = buildImageEraseRequest(0);
    expect(decodeSmpHeader(frame).len).toBe(frame.length - 8);
  });

  test('buildImageTestRequest: len === payload length', () => {
    const frame = buildImageTestRequest(0, new Uint8Array(32));
    expect(decodeSmpHeader(frame).len).toBe(frame.length - 8);
  });

  test('buildImageConfirmRequest: len === payload length', () => {
    const frame = buildImageConfirmRequest(0, new Uint8Array(32));
    expect(decodeSmpHeader(frame).len).toBe(frame.length - 8);
  });
});
