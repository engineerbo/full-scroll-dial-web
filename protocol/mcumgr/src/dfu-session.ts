/**
 * DFU session orchestrator.
 *
 * Coordinates the full firmware upgrade flow over a connected
 * {@link SmpTransport}:
 *
 * ```
 * 1. parseImageInfo(binFile)   — validate MCUboot magic, extract SHA-256
 * 2. buildImageEraseRequest()  — erase secondary slot (auto-determined)
 * 3. upload loop               — send chunks until device acknowledges all bytes
 * 4. buildImageTestRequest()   — mark image for test-boot on next reset
 * ```
 *
 * ## Upload flow
 *
 * Event-driven: each upload response triggers the next chunk send.
 * `DfuSession` registers an `onFrame` callback on the transport for the
 * duration of `run()`.
 *
 * Offset tracking: the local offset is advanced eagerly before sending each
 * chunk, then overwritten with the device's acknowledged offset from the
 * response.  A response with `off=0` is treated as a session-recovery signal
 * rather than an advance — see Session Recovery below.
 *
 * ## Session recovery
 *
 * From the Image Management specification:
 * > "It is possible that a server will respond to an upload with 'off' of 0,
 * >  this may happen if an upload on another transport is started, if the
 * >  device has rebooted or if a packet has been lost."
 * >
 * > "In such case a client must re-send all the required and optional fields
 * >  that are expected when 'off' is 0."
 *
 * `DfuSession` detects `nextOffset === 0` from {@link parseImageUploadResponse}
 * and restarts the loop from offset 0 with `len`, `sha`, and `upgrade` present.
 *
 * ## No built-in timeout
 *
 * No per-chunk timeout or retry is implemented.  Callers that need a timeout
 * should race `run()` against a `setTimeout` rejection, or use `AbortSignal`
 * if added in a future revision.
 *
 * @see {@link https://docs.zephyrproject.org/latest/services/device_mgmt/smp_groups/smp_group_1.html}
 */

import type { SmpTransport } from './transport.js';
import {
  parseImageInfo as _parseImageInfo,
  buildImageStateRequest,
  buildImageEraseRequest,
  parseImageEraseResponse,
  buildImageUploadChunk,
  parseImageUploadResponse,
  buildImageTestRequest,
  buildImageConfirmRequest,
  parseImageStateResponse,
  buildImageSlotInfoRequest,
  parseImageSlotInfoResponse,
  SmpError,
  type McubootImageInfo,
} from './image-commands.js';
import { buildOsResetRequest } from './os-commands.js';
import { Rc } from './constants.js';

// ---------------------------------------------------------------------------
// Progress types
// ---------------------------------------------------------------------------

/** Progress event emitted by {@link DfuSession.onProgress} at each phase transition. */
export interface DfuProgress {
  phase: 'erasing' | 'uploading' | 'testing' | 'done' | 'error';
  /** 0–100 during `uploading`; absent for other phases. */
  percentage?: number;
  /** Human-readable error description; present only when `phase === 'error'`. */
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown (and used as the `DfuProgress.errorMessage` source) when the DFU
 * session encounters a device-reported error or an unexpected state.
 */
export class DfuError extends Error {
  /**
   * MCUmgr return code if the failure originated from a device response;
   * `undefined` for image-validation or transport errors.
   */
  readonly rc: number | undefined;

  constructor(message: string, rc?: number) {
    super(message);
    this.name = 'DfuError';
    this.rc = rc;
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Orchestrates a complete DFU cycle.
 *
 * The `transport` must already be connected before calling `run()`.
 *
 * ## Slot detection
 *
 * Two strategies are used, attempted in order:
 *
 * 1. **Slot Info command (ID 6)** — lists physical slots regardless of
 *    whether they contain valid images. This gives a definitive 1-vs-2
 *    slot answer in a single round-trip. If the device does not support
 *    this command, we fall back to the "State of images" heuristic below.
 *
 * 2. **Fallback: two state queries** — the "State of images" response lists
 *    only **valid** images; an empty secondary slot is not reported:
 *
 *    > "A response will only contain information for valid images, if an
 *    >  image can not be identified as valid it is simply skipped."
 *
 *    **Pre-DFU** — determines whether to erase:
 *      - `images.length > 1` → secondary slot is populated → erase slot 1
 *      - `images.length === 1` → ambiguous (1-slot device **or** 2-slot
 *        with empty secondary) → attempt erase; if the device returns
 *        `NO_EXEC (8)` there is no secondary slot, so we continue without
 *        erasing.
 *
 *    **Post-DFU** — determines how to finalize (test vs. confirm):
 *      - `images.length > 1` → upload went to secondary slot → send
 *        **test** (`confirm: false`) so MCUboot swaps on next reset.
 *      - `images.length === 1` → upload directly overwrote slot 0 on a
 *        1-slot device → send **confirm** (`confirm: true`) to mark the
 *        image permanent.
 *
 * @example
 * ```ts
 * const transport = new SerialSmpTransport(() => navigator.serial.requestPort());
 * await transport.connect();
 *
 * const session = new DfuSession(transport);
 * session.onProgress = ({ phase, percentage }) => {
 *   console.log(phase, percentage);
 * };
 *
 * await session.run(await file.arrayBuffer());
 * ```
 */
export class DfuSession {
  /**
   * Called at each phase transition and after every upload chunk response.
   * Set to `null` to suppress progress events.
   */
  onProgress: ((progress: DfuProgress) => void) | null = null;

  /**
   * @param transport - An already-connected {@link SmpTransport}.
   */
  constructor(private readonly transport: SmpTransport) {}

  private _seqCounter = 0;
  private _pendingResolve: ((frame: Uint8Array) => void) | null = null;
  private _pendingReject: ((reason: unknown) => void) | null = null;

  private _emitProgress(p: DfuProgress): void {
    this.onProgress?.(p);
  }

  private _nextSeq(): number {
    const seq = this._seqCounter;
    this._seqCounter = (this._seqCounter + 1) & 0xff;
    return seq;
  }

  private _registerFrameHandler(): void {
    this.transport.onFrame((frame: Uint8Array) => {
      if (this._pendingResolve) {
        const r = this._pendingResolve;
        this._pendingResolve = null;
        this._pendingReject = null;
        r(frame);
      }
    });
    this.transport.onError((err: Error) => {
      if (this._pendingReject) {
        const r = this._pendingReject;
        this._pendingResolve = null;
        this._pendingReject = null;
        r(err);
      }
    });
  }

  private async _sendAndWait(frame: Uint8Array): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      this._pendingResolve = resolve;
      this._pendingReject = reject;
      this.transport.send(frame).catch((err: unknown) => {
        if (this._pendingReject) {
          const r = this._pendingReject;
          this._pendingResolve = null;
          this._pendingReject = null;
          r(err);
        }
      });
    });
  }

  /**
   * Validates `image`, runs the DFU flow, and resolves when the image has
   * been marked for test-boot (2-slot) or confirmed (1-slot).
   *
   * The full flow:
   * 1. **Validate** — calls {@link parseImageInfo}; rejects immediately if the
   *    file is not a valid MCUboot image.
   * 2. **Query pre-DFU state** — determines slot configuration from the
   *    device's image list.
   * 3. **Erase** — auto-determined: on a 2-slot device sends
   *    {@link buildImageEraseRequest} for slot 1. If the device is ambiguous
   *    (1 vs. 2 slots) we attempt erase and gracefully continue if the
   *    device reports `NO_EXEC` (no secondary slot exists).
   * 4. **Upload** — sends chunks via {@link buildImageUploadChunk} in a
   *    stop-and-wait loop driven by the device's `off` responses:
   *    - Emits `{ phase: 'uploading', percentage }` after each ACK.
   *    - On `nextOffset === 0` (session recovery): restarts from offset 0.
   *    - Rejects with {@link DfuError} on any non-zero `rc`.
   * 5. **Query post-DFU state** — how many valid images now?
   *    - `> 1`: upload went to secondary slot → send **test**
   *      ({@link buildImageTestRequest}, `confirm: false`).
   *    - `=== 1`: upload overwrote slot 0 on a 1-slot device → send
   *      **confirm** ({@link buildImageConfirmRequest}, `confirm: true`).
   * 6. Emits `{ phase: 'done' }` and resolves.
   *
   * On any error: emits `{ phase: 'error', errorMessage }` then rejects.
   *
   * @param image - Raw `.bin` file contents (`ArrayBuffer`).
   * @returns Resolves when the device has acknowledged the update.
   * @throws {DfuError} on device error or image validation failure.
   */
  async run(image: ArrayBuffer): Promise<void> {
    this._registerFrameHandler();

    try {
      const imageInfo = await _parseImageInfo(image);
      const imageBytes = new Uint8Array(image);

      // ------------------------------------------------------------------
      // Slot detection — try Slot Info first; fall back to state queries
      // ------------------------------------------------------------------
      let slotCount: number | null;
      let fallback = false;
      const slotInfo = await this._trySlotInfo();
      if (slotInfo !== null) {
        slotCount = slotInfo;
      } else {
        slotCount = null;
        fallback = true;
      }

      // ------------------------------------------------------------------
      // Erase (auto-determined)
      // ------------------------------------------------------------------
      if (slotCount !== null && slotCount > 1) {
        await this._doErase();
      } else if (slotCount !== null && slotCount === 1) {
        // Slot Info says 1-slot — skip erase
      } else if (!fallback) {
        // Slot Info gave unexpected value — treat as unknown
        fallback = true;
      }

      if (fallback) {
        // Fallback: use state query to decide erase
        const preImages = await this._querySlotCount();

        if (preImages > 1) {
          await this._doErase();
        } else {
          // Ambiguous: attempt erase; NO_EXEC means 1-slot device.
          try {
            await this._doErase();
          } catch (err) {
            if (err instanceof SmpError && err.rc === Rc.NO_EXEC) {
              // No secondary slot — 1-slot device, continue
            } else {
              throw err;
            }
          }
        }
      }

      // ------------------------------------------------------------------
      // Upload (shared by both 1-slot and 2-slot)
      // ------------------------------------------------------------------
      await this._doUpload(imageInfo, imageBytes);

      // ------------------------------------------------------------------
      // Finalize — test (2-slot) or confirm (1-slot)
      // ------------------------------------------------------------------
      this._emitProgress({ phase: 'testing' });
      // Some devices don't support test/confirm state writes.
      // The upload already completed; treat NO_EXEC as success.
      try {
        const finalSlotCount = fallback
          ? await this._querySlotCount()
          : slotCount!;
        await this._doFinalize(finalSlotCount, imageInfo.sha256);
      } catch (finalizeErr) {
        if (finalizeErr instanceof SmpError && finalizeErr.rc === Rc.NO_EXEC) {
          // Device doesn't support test/confirm — upload is still valid
        } else {
          throw finalizeErr;
        }
      }

      this._emitProgress({ phase: 'done' });

      await this.reset();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const rc =
        err instanceof SmpError
          ? err.rc
          : err instanceof DfuError
            ? err.rc
            : undefined;
      this._emitProgress({ phase: 'error', errorMessage: msg });
      if (err instanceof DfuError) throw err;
      throw new DfuError(msg, rc);
    } finally {
      this._pendingResolve = null;
      this._pendingReject = null;
    }
  }

  /**
   * Sends an Image State read request and returns the number of valid
   * images (i.e. `images.length`) reported by the device.
   *
   * Per the mcumgr spec an empty secondary slot is not listed, so
   * `1` may mean "1-slot device" **or** "2-slot device with empty
   * secondary slot".
   */
  private async _querySlotCount(): Promise<number> {
    const req = buildImageStateRequest(this._nextSeq());
    const resp = await this._sendAndWait(req);
    const parsed = parseImageStateResponse(resp);
    return parsed.images.length;
  }

  /**
   * Attempts to determine the slot count via the Slot Info command (ID 6).
   *
   * Returns the number of physical slots for image 0 (1 or 2), or `null`
   * if the device does not support Slot Info (any error is treated as
   * "not supported").
   */
  private async _trySlotInfo(): Promise<number | null> {
    try {
      const req = buildImageSlotInfoRequest(this._nextSeq());
      const resp = await this._sendAndWait(req);
      const parsed = parseImageSlotInfoResponse(resp);
      const image0 =
        parsed.images.find((i) => i.image === 0) ?? parsed.images[0];
      if (!image0 || !Array.isArray(image0.slots)) return null;
      return image0.slots.length;
    } catch {
      return null;
    }
  }

  /**
   * Uploads the firmware image to the device in chunks.
   * Emits progress events and handles session recovery (off=0).
   */
  private async _doUpload(
    imageInfo: McubootImageInfo,
    imageBytes: Uint8Array
  ): Promise<void> {
    this._emitProgress({ phase: 'uploading', percentage: 0 });

    let offset = 0;
    const totalBytes = imageBytes.length;

    while (offset < totalBytes) {
      const chunk = buildImageUploadChunk(
        this._nextSeq(),
        offset,
        imageBytes,
        offset === 0
          ? { mtu: 140, sha256: imageInfo.sha256, totalLen: totalBytes }
          : { mtu: 140 }
      );

      const resp = await this._sendAndWait(chunk);
      const parsed = parseImageUploadResponse(resp);

      offset = parsed.nextOffset;

      const pct = Math.min(100, Math.round((offset / totalBytes) * 100));
      this._emitProgress({ phase: 'uploading', percentage: pct });
    }
  }

  private async _doErase(): Promise<void> {
    this._emitProgress({ phase: 'erasing' });
    const eraseResp = await this._sendAndWait(
      buildImageEraseRequest(this._nextSeq(), 1)
    );
    parseImageEraseResponse(eraseResp);
  }

  private async _doFinalize(
    slotCount: number,
    sha256: Uint8Array
  ): Promise<void> {
    const req =
      slotCount > 1
        ? buildImageTestRequest(this._nextSeq(), sha256)
        : buildImageConfirmRequest(this._nextSeq(), sha256);
    const resp = await this._sendAndWait(req);
    parseImageStateResponse(resp);
  }

  /**
   * Sends an OS reset command to the device.
   *
   * The device will reboot shortly after acknowledging this request.
   * Errors (e.g. reset not supported) are silently ignored — the DFU
   * itself already completed.
   */
  async reset(): Promise<void> {
    try {
      const req = buildOsResetRequest(this._nextSeq());
      await this.transport.send(req);
    } catch {
      // Reset is best-effort
    }
  }
}
