/**
 * Image Management group (Group 1) request builders and response parsers.
 *
 * Each builder returns a complete raw SMP frame (8-byte header + CBOR
 * payload) ready to pass to {@link SmpTransport.send}.  Each parser accepts
 * a raw SMP frame and returns a typed result, or throws {@link SmpError} if
 * the device reported a failure.
 *
 * CBOR encoding/decoding uses the `cborg` package:
 * ```ts
 * import { encode as cborEncode, decode as cborDecode } from 'cborg';
 * ```
 *
 * @see {@link https://docs.zephyrproject.org/latest/services/device_mgmt/smp_groups/smp_group_1.html}
 */

import { encodeSmpHeader } from './smp-header.js';
import { Op, Group, ImgCmd, Rc } from './constants.js';
import { encode as cborEncode, decode as cborDecode } from 'cborg';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown by response parsers when the device returns a non-zero return code.
 *
 * Handles both the SMP v0 legacy format `{"rc": int}` and the SMP v1 format
 * `{"err": {"group": uint, "rc": uint}}`.
 */
export class SmpError extends Error {
  /** MCUmgr return code (see {@link Rc}). */
  readonly rc: number;

  constructor(message: string, rc: number) {
    super(message);
    this.name = 'SmpError';
    this.rc = rc;
  }
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/** One entry in the image list returned by the device. */
export interface ImageInfo {
  /** Image number (0-based). */
  image?: number | undefined;
  /** Slot within the image: 0 = primary (running), 1 = secondary (upgrade). */
  slot: number;
  /** Firmware version string, e.g. `"1.2.3+4"`. */
  version: string;
  /** SHA-256 hash of the image, 32 bytes. */
  hash?: Uint8Array | undefined;
  bootable?: boolean | undefined;
  pending?: boolean | undefined;
  confirmed?: boolean | undefined;
  active?: boolean | undefined;
  permanent?: boolean | undefined;
}

/** Parsed response to an Image State read request. */
export interface ImageStateResponse {
  images: ImageInfo[];
}

/** Parsed response to an Image Upload write request. */
export interface ImageUploadResponse {
  /**
   * From the spec:
   * > "offset of last successfully written byte of update"
   *
   * This is the next offset the device expects; advance the upload cursor to
   * this value before sending the next chunk.
   */
  nextOffset: number;
  /**
   * From the spec:
   * > "indicates if the uploaded data successfully matches the provided
   * >  SHA256 hash or not"
   *
   * Present only after the final chunk on firmware that performs SHA-256
   * verification.
   */
  match?: boolean;
}

/** Metadata parsed from a MCUboot-format `.bin` file. */
export interface McubootImageInfo {
  /** Size of the image body in bytes (excludes the 32-byte header). */
  imageSize: number;
  /** Version string `"major.minor.revision+build"`. */
  version: string;
  /**
   * SHA-256 of the entire firmware file (`image`).
   * This is the value to send in the `sha` field of the first upload chunk.
   */
  sha256: Uint8Array;
}

// ---------------------------------------------------------------------------
// Slot Info types (Command 6)
// ---------------------------------------------------------------------------

/** One physical slot entry from a Slot Info response. */
export interface SlotInfo {
  /** Slot number: 0 = primary (running), 1 = secondary (upgrade). */
  slot: number;
  /** Size of the slot in bytes. */
  size: number;
  /**
   * Optional field (only present if
   * `CONFIG_MCUMGR_GRP_IMG_DIRECT_UPLOAD` is enabled).
   */
  uploadImageId?: number | undefined;
}

/** One image entry from a Slot Info response. */
export interface ImageSlotInfo {
  /** Image number. */
  image: number;
  /** Physical slots belonging to this image. */
  slots: SlotInfo[];
  /**
   * Optional field (only present if
   * `CONFIG_MCUMGR_GRP_IMG_TOO_LARGE_SYSBUILD` or
   * `CONFIG_MCUMGR_GRP_IMG_TOO_LARGE_BOOTLOADER_INFO` is enabled).
   */
  maxImageSize?: number | undefined;
}

/** Parsed response to a Slot Info read request. */
export interface SlotInfoResponse {
  images: ImageSlotInfo[];
}

// ---------------------------------------------------------------------------
// Image State (Command 0)
// ---------------------------------------------------------------------------

/**
 * Builds a request to read the current image state from the device.
 *
 * From the spec:
 * > Op: `READ (0)`, Group: `IMAGE (1)`, Command: `STATE (0)`
 * > Data: empty CBOR map `{}`
 *
 * @param seq - Sequence number (0–255, caller manages wrapping).
 * @returns Raw SMP frame (9 bytes: 8-byte header + `0xa0` empty map).
 */
export function buildImageStateRequest(
  seq: number,
  image?: number
): Uint8Array {
  return buildSmpFrame(
    Op.READ,
    seq,
    ImgCmd.STATE,
    cborEncode(image !== undefined ? { image } : {})
  );
}

/**
 * Parses a device response to an Image State request.
 *
 * Response CBOR fields (from the spec):
 * - `images` (array): list of image descriptors, each containing:
 *   - `image` (uint, optional): image number
 *   - `slot` (uint): 0 = primary, 1 = secondary
 *   - `version` (str): version string
 *   - `hash` (bstr, optional): SHA-256 hash
 *   - `bootable`, `pending`, `confirmed`, `active`, `permanent` (bool, optional)
 *
 * @param frame - Raw SMP frame from the device.
 * @returns Parsed image list.
 * @throws {SmpError} if the response contains a non-zero return code.
 */
export function parseImageStateResponse(frame: Uint8Array): ImageStateResponse {
  const cbor = decodeAndCheck(frame, 'Image state error');

  const rawImages = cbor.images;
  const images: ImageInfo[] = [];
  if (Array.isArray(rawImages)) {
    for (const img of rawImages as Record<string, unknown>[]) {
      images.push({
        image: img.image as number | undefined,
        slot: img.slot as number,
        version: img.version as string,
        hash: img.hash as Uint8Array | undefined,
        bootable: img.bootable as boolean | undefined,
        pending: img.pending as boolean | undefined,
        confirmed: img.confirmed as boolean | undefined,
        active: img.active as boolean | undefined,
        permanent: img.permanent as boolean | undefined,
      });
    }
  }
  return { images };
}

// ---------------------------------------------------------------------------
// Image Upload (Command 1)
// ---------------------------------------------------------------------------

/**
 * Options for the first upload chunk (`offset === 0`).
 * All fields are required at offset 0 and must be omitted for subsequent
 * chunks.
 */
export interface UploadFirstChunkOpts {
  /**
   * From the spec:
   * > "optional length of an image. Must appear when 'off' is 0"
   */
  totalLen: number;
  /**
   * From the spec:
   * > "SHA256 hash of an upload; this is used to identify an upload session
   * >  (in case of lost packets, device reboot, etc.) and for verifying the
   * >  upload. Must appear when 'off' is 0"
   * 32 bytes.
   */
  sha256: Uint8Array;
  /**
   * From the spec:
   * > "optional flag that states that only upgrade should be allowed, i.e.
   * >  only a firmware with higher version number should be accepted.
   * >  Should only be present when 'off' is 0"
   */
  upgrade?: boolean;
  /**
   * From the spec:
   * > "optional image number, it does not have to appear in request at all,
   * >  in which case it is assumed to be 0"
   * For single-image devices this can be omitted.
   */
  imageNumber?: number;
}

/**
 * Builds one upload chunk request.
 *
 * Chunk sizing is MTU-aware: the CBOR map is first constructed with an empty
 * `data` field to measure its overhead, then `data` is filled to consume the
 * remaining budget:
 * ```
 * chunkSize = mtu - cborEncode({data: empty, off, ...firstChunkFields}).length - 8
 * ```
 *
 * Request CBOR fields (from the spec):
 * - `off` (uint): **always present** — "offset of image chunk the request carries"
 * - `data` (bstr): **always present** — "image data to write at provided offset"
 * - `len` (uint): **offset=0 only** — "optional length of an image. Must appear when 'off' is 0"
 * - `sha` (bstr): **offset=0 only** — "SHA256 hash of an upload … Must appear when 'off' is 0"
 * - `upgrade` (bool): **offset=0, optional** — enforce version check
 * - `image` (uint): **offset=0, optional** — target image number (default 0)
 *
 * @param seq - Sequence number.
 * @param offset - Byte offset within the image for this chunk.
 * @param image - The full firmware image (used to slice the chunk and compute
 *   chunk boundaries).
 * @param opts.mtu - Total SMP frame budget in bytes; defaults to 140.
 * @param opts.sha256 - Required when `offset === 0`; 32-byte SHA-256 of the
 *   full image as returned by {@link parseImageInfo}.
 * @param opts.totalLen - Required when `offset === 0`.
 * @param opts.upgrade - Optional; only included when `offset === 0`.
 * @param opts.imageNumber - Optional; only included when `offset === 0`.
 * @returns Raw SMP frame.
 */
export function buildImageUploadChunk(
  seq: number,
  offset: number,
  image: Uint8Array,
  opts?: { mtu?: number } & Partial<UploadFirstChunkOpts>
): Uint8Array {
  const mtu = opts?.mtu ?? 140;
  const nmpOverhead = 8;

  const map: Record<string, unknown> = { off: offset, data: new Uint8Array(0) };
  if (offset === 0) {
    if (opts?.sha256 === undefined || opts?.totalLen === undefined) {
      throw new Error('sha256 and totalLen are required when offset === 0');
    }
    map.len = opts.totalLen;
    map.sha = opts.sha256;
    if (opts.upgrade !== undefined) map.upgrade = opts.upgrade;
    if (opts.imageNumber !== undefined) map.image = opts.imageNumber;
  }

  const overhead = cborEncode(map).length + nmpOverhead + 2;
  const maxDataBytes = Math.max(0, mtu - overhead);
  if (maxDataBytes <= 0) {
    throw new Error(
      `MTU ${mtu} too small for upload chunk overhead (${overhead} bytes)`
    );
  }
  const chunkEnd = Math.min(offset + maxDataBytes, image.length);
  map.data = image.subarray(offset, chunkEnd);

  return buildSmpFrame(Op.WRITE, seq, ImgCmd.UPLOAD, cborEncode(map));
}

/**
 * Parses a device response to an Image Upload chunk request.
 *
 * Response CBOR fields (from the spec):
 * - `off` (uint, optional): "offset of last successfully written byte of update"
 * - `match` (bool, optional): "indicates if the uploaded data successfully
 *   matches the provided SHA256 hash or not"
 *
 * Session recovery:
 * > "It is possible that a server will respond to an upload with 'off' of 0,
 * >  this may happen if an upload on another transport is started, if the
 * >  device has rebooted or if a packet has been lost."
 * >
 * > "In such case a client must re-send all the required and optional fields
 * >  that are expected when 'off' is 0."
 *
 * When `nextOffset === 0` the caller (DfuSession) must restart the upload
 * from the beginning with a first-chunk payload (`len`, `sha` present).
 *
 * @param frame - Raw SMP frame from the device.
 * @returns `{ nextOffset, match? }`.
 * @throws {SmpError} if the response contains a non-zero return code.
 */
export function parseImageUploadResponse(
  frame: Uint8Array
): ImageUploadResponse {
  const cbor = decodeAndCheck(frame, 'Upload error');

  const result: ImageUploadResponse = {
    nextOffset: (cbor.off as number) ?? 0,
  };
  if (cbor.match !== undefined) result.match = cbor.match as boolean;
  return result;
}

// ---------------------------------------------------------------------------
// Image Erase (Command 5)
// ---------------------------------------------------------------------------

/**
 * Builds a request to erase an image slot.
 *
 * From the spec:
 * > Op: `WRITE (2)`, Group: `IMAGE (1)`, Command: `ERASE (5)`
 *
 * Request CBOR field:
 * - `slot` (uint, optional): "optional slot number, it does not have to appear
 *   in the request at all, in which case it is assumed to be 1"
 *
 * Response:
 * > "The command sends an empty CBOR map as data if successful"
 *
 * Note: erase is synchronous on the device side; the response is delayed
 * until the operation completes (may take several seconds on slow flash).
 *
 * @param seq - Sequence number.
 * @param slot - Slot to erase; defaults to 1 (secondary/upgrade slot).
 *   Pass `undefined` to omit the field entirely (device defaults to slot 1).
 * @returns Raw SMP frame.
 */
export function buildImageEraseRequest(seq: number, slot?: number): Uint8Array {
  const map: Record<string, unknown> = {};
  if (slot !== undefined) map.slot = slot;
  return buildSmpFrame(Op.WRITE, seq, ImgCmd.ERASE, cborEncode(map));
}

/**
 * Parses a device response to an Image Erase request.
 *
 * @param frame - Raw SMP frame from the device.
 * @throws {SmpError} if the response contains a non-zero return code.
 *   In particular, `Rc.BAD_STATE (6)` is returned when the target slot is
 *   currently marked for the next boot and cannot be erased.
 */
export function parseImageEraseResponse(frame: Uint8Array): void {
  decodeAndCheck(frame, 'Erase error');
}

// ---------------------------------------------------------------------------
// Slot Info (Command 6)
// ---------------------------------------------------------------------------

/**
 * Builds a request to enumerate physical slots on the device.
 *
 * From the spec:
 * > Op: `READ (0)`, Group: `IMAGE (1)`, Command: `SLOT_INFO (6)`
 * > Data: empty CBOR map `{}`
 *
 * The response lists every physical slot regardless of whether it contains
 * a valid image, making this the definitive way to determine whether a
 * device has 1 slot or 2 slots.
 *
 * @param seq - Sequence number (0–255).
 * @returns Raw SMP frame (9 bytes: 8-byte header + `0xa0` empty map).
 */
export function buildImageSlotInfoRequest(seq: number): Uint8Array {
  return buildSmpFrame(Op.READ, seq, ImgCmd.SLOT_INFO, cborEncode({}));
}

/**
 * Parses a device response to a Slot Info request.
 *
 * Response CBOR fields (from the spec):
 * ```json
 * {
 *   "images": [
 *     {
 *       "image": (uint),
 *       "slots": [
 *         { "slot": (uint), "size": (uint), "upload_image_id": (uint, opt) }
 *       ],
 *       "max_image_size": (uint, opt)
 *     }
 *   ]
 * }
 * ```
 *
 * @param frame - Raw SMP frame from the device.
 * @returns Parsed slot info.
 * @throws {SmpError} if the response contains a non-zero return code.
 */
export function parseImageSlotInfoResponse(
  frame: Uint8Array
): SlotInfoResponse {
  const cbor = decodeAndCheck(frame, 'Slot info error');

  const rawImages = cbor.images;
  const images: ImageSlotInfo[] = [];
  if (Array.isArray(rawImages)) {
    for (const img of rawImages as Record<string, unknown>[]) {
      const rawSlots = img.slots as Record<string, unknown>[] | undefined;
      images.push({
        image: img.image as number,
        slots: Array.isArray(rawSlots)
          ? rawSlots.map((s) => ({
              slot: s.slot as number,
              size: s.size as number,
              uploadImageId: s.upload_image_id as number | undefined,
            }))
          : [],
        maxImageSize: img.max_image_size as number | undefined,
      });
    }
  }
  return { images };
}

// ---------------------------------------------------------------------------
// Image Test / Confirm (Command 0, write)
// ---------------------------------------------------------------------------

/**
 * Builds a request to mark an image for test-boot on the next reset.
 *
 * From the spec, State Set Request:
 * - `hash` (bstr): target image identifier
 * - `confirm` (bool): `false` = test mode (reverts after one boot);
 *                     `true`  = permanently confirm
 *
 * @param seq - Sequence number.
 * @param hash - SHA-256 hash of the target image (32 bytes), as returned in
 *   {@link ImageInfo.hash} from {@link parseImageStateResponse}.
 * @returns Raw SMP frame.
 */
export function buildImageTestRequest(
  seq: number,
  hash: Uint8Array
): Uint8Array {
  return buildSmpFrame(
    Op.WRITE,
    seq,
    ImgCmd.STATE,
    cborEncode({ hash, confirm: false })
  );
}

/**
 * Builds a request to permanently confirm the currently running image.
 *
 * Sets `confirm: true` in the CBOR map so the image survives reset without
 * reverting.
 *
 * @param seq - Sequence number.
 * @param hash - SHA-256 hash of the image to confirm (32 bytes).
 * @returns Raw SMP frame.
 */
export function buildImageConfirmRequest(
  seq: number,
  hash: Uint8Array
): Uint8Array {
  return buildSmpFrame(
    Op.WRITE,
    seq,
    ImgCmd.STATE,
    cborEncode({ hash, confirm: true })
  );
}

// ---------------------------------------------------------------------------
// MCUboot image file validation
// ---------------------------------------------------------------------------

/**
 * Validates a MCUboot `.bin` file and extracts the metadata needed for upload.
 *
 * MCUboot image header layout
 * ({@link https://docs.mcuboot.com/design.html}):
 *
 * ```
 * Offset  Size  Field                  Expected value
 * 0       4     Magic (LE)             0x96f3b83d
 * 4       4     Load address (LE)      0x00000000
 * 8       2     Header size (LE)       any
 * 10      2     Protected TLV size     0x0000
 * 12      4     Image size (LE)        must satisfy: headerSize + imageSize ≤ file.byteLength
 * 20      1     Version major
 * 21      1     Version minor
 * 22      2     Version revision (LE)
 * 24      4     Version build num (LE)
 * ```
 *
 * SHA-256 is computed over the first `headerSize + imageSize` bytes only
 * (the header and image body), matching the reference implementation and
 * what the device verifies. Any TLV data appended after the image body is
 * excluded from the hash.
 *
 * @param image - Raw `.bin` file contents.
 * @returns Image metadata: `{ imageSize, version, sha256 }`.
 * @throws {Error} with a descriptive message on any validation failure:
 *   - `"Invalid image (too short file)"` — fewer than 32 bytes
 *   - `"Invalid image (wrong magic bytes)"` — magic ≠ 0x96f3b83d
 *   - `"Invalid image (wrong load address)"` — load address ≠ 0
 *   - `"Invalid image (wrong protected TLV area size)"` — protected TLV ≠ 0
 *   - `"Invalid image (wrong image size)"` — stated size exceeds file bounds
 */
export async function parseImageInfo(
  image: ArrayBuffer
): Promise<McubootImageInfo> {
  const buf = new Uint8Array(image);
  if (buf.length < 32) {
    throw new Error('Invalid image (too short file)');
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== 0x96f3b83d) {
    throw new Error('Invalid image (wrong magic bytes)');
  }

  const loadAddr = view.getUint32(4, true);
  if (loadAddr !== 0x00000000) {
    throw new Error('Invalid image (wrong load address)');
  }

  const protectedTlv = view.getUint16(10, true);
  if (protectedTlv !== 0x0000) {
    throw new Error('Invalid image (wrong protected TLV area size)');
  }

  const headerSize = view.getUint16(8, true);
  const imageSize = view.getUint32(12, true);
  const totalNeeded = Math.max(32, headerSize) + imageSize;
  if (totalNeeded > buf.length) {
    throw new Error('Invalid image (wrong image size)');
  }

  const major = buf[20];
  const minor = buf[21];
  const revision = view.getUint16(22, true);
  const build = view.getUint32(24, true);
  const version = `${major}.${minor}.${revision}+${build}`;

  const hashSliceEnd = Math.max(headerSize, 32) + imageSize;
  const sha256 = new Uint8Array(
    await crypto.subtle.digest('SHA-256', buf.slice(0, hashSliceEnd))
  );

  return { imageSize, version, sha256 };
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for testing)
// ---------------------------------------------------------------------------

function buildSmpFrame(
  op: number,
  seq: number,
  id: number,
  payload: Uint8Array
): Uint8Array {
  const header = encodeSmpHeader({
    op,
    flags: 0,
    len: payload.length,
    group: Group.IMAGE,
    seq,
    id,
  });
  const frame = new Uint8Array(header.length + payload.length);
  frame.set(header, 0);
  frame.set(payload, header.length);
  return frame;
}

function decodeAndCheck(
  frame: Uint8Array,
  label: string
): Record<string, unknown> {
  const cbor = cborDecode(frame.subarray(8)) as Record<string, unknown>;
  const rc = extractRc(cbor);
  if (rc !== Rc.OK) throw new SmpError(`${label}: rc=${rc}`, rc);
  return cbor;
}

/**
 * Extracts the return code from a CBOR response map, handling both the SMP
 * v0 legacy format and the SMP v1 format.
 *
 * SMP v0 (legacy):
 * ```json
 * {"rc": 6}
 * ```
 * SMP v1 (newer firmware):
 * ```json
 * {"err": {"group": 1, "rc": 3}}
 * ```
 *
 * From the SMP protocol specification:
 * > "SMP Version 2 Response: {"err": {"group": (uint), "rc": (uint)}}"
 * > "SMP Version 1 Response: {"rc": (int)}"
 * > "Success is indicated by an empty map or absent error fields."
 *
 * @param cbor - Decoded CBOR map (plain JS object from `cborg.decode`).
 * @returns `0` if successful; the non-zero rc value otherwise.
 */
export function extractRc(cbor: Record<string, unknown>): number {
  const err = cbor.err;
  if (err && typeof err === 'object') {
    const rc = (err as Record<string, unknown>).rc;
    if (typeof rc === 'number') return rc;
  }
  if (typeof cbor.rc === 'number') return cbor.rc;
  return Rc.OK;
}
