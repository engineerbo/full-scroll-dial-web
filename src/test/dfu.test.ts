// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import { encode as cborEncode } from 'cborg';
import { bindDfuController } from '../dfu';
import type { DfuProgress } from '../../protocol/mcumgr';

// ── Shared mock state ────────────────────────────────────────────────────────
// These are captured by mock factories via closure; values are read at call time,
// not at factory creation time, so the hoisted vi.mock calls work correctly.

import type { MockSmpTransport } from '../../protocol/mcumgr';
let latestTransport: MockSmpTransport = null!;

let capturedDfuSession: {
  onProgress: ((p: DfuProgress) => void) | null;
  run: ReturnType<typeof vi.fn>;
} | null = null;

// runImpl is called when session.run() is invoked. Override per-test to control
// progress events and resolution. Default: resolve immediately (no-op flash).
let runImpl: () => Promise<void> = async () => {};

// connectError: when non-null, the next SerialSmpTransport instance will throw
// this error from connect(). Reset to null after each use.
let connectError: Error | DOMException | null = null;

// parseImageInfo substitute. Default: return valid metadata.
let parseImageInfoImpl: () => Promise<{
  imageSize: number;
  version: string;
  sha256: Uint8Array;
}> = () =>
  Promise.resolve({
    imageSize: 1,
    version: '1.2.3+0',
    sha256: new Uint8Array(32),
  });

// ── Mock factories ────────────────────────────────────────────────────────────

vi.mock('../dfu-steps', () => ({ renderDfuSteps: vi.fn() }));

// Mock the individual source modules that dfu.ts transitively imports via the
// barrel. Vite resolves barrel re-exports to their source files, so mocking
// the barrel path alone does not intercept the bound symbols.

vi.mock('../../protocol/mcumgr/src/transport', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../protocol/mcumgr/src/transport')
    >();
  return {
    ...actual,
    SerialSmpTransport: vi.fn(function MockSerial() {
      latestTransport = new actual.MockSmpTransport();
      if (connectError !== null) {
        const err = connectError;
        connectError = null;
        latestTransport.connect = async () => {
          throw err;
        };
      }
      return latestTransport;
    }),
  };
});

vi.mock('../../protocol/mcumgr/src/dfu-session', () => ({
  DfuSession: vi.fn(function MockSession() {
    const session = {
      onProgress: null as ((p: DfuProgress) => void) | null,
      run: vi.fn().mockImplementation(() => runImpl()),
    };
    capturedDfuSession = session;
    return session;
  }),
}));

vi.mock('../../protocol/mcumgr/src/image-commands', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../protocol/mcumgr/src/image-commands')
    >();
  return {
    ...actual,
    parseImageInfo: () => parseImageInfoImpl(),
  };
});

// ── SMP frame builders ────────────────────────────────────────────────────────
// parsers only read bytes 8+, so the 8-byte header can be all zeros.

function okStateFrame(
  images: Array<{
    slot: number;
    version: string;
    active?: boolean;
    confirmed?: boolean;
  }>
): Uint8Array {
  const payload = cborEncode({ images });
  const frame = new Uint8Array(8 + payload.length);
  frame.set(payload, 8);
  return frame;
}

function errorFrame(rc: number): Uint8Array {
  const payload = cborEncode({ rc });
  const frame = new Uint8Array(8 + payload.length);
  frame.set(payload, 8);
  return frame;
}

// ── DOM/panel factory ─────────────────────────────────────────────────────────

const FAKE_PORT = null as unknown as SerialPort;

function makePanel() {
  document.body.innerHTML = '<div id="dfuStepsMount"></div>';

  const mount = document.createElement('div');
  document.body.appendChild(mount);

  const connectBtn = document.createElement('button') as HTMLButtonElement;
  const modePill = document.createElement('div') as HTMLDivElement;
  const dfuGuideSection = document.createElement('div') as HTMLDivElement;
  const setStatus = vi.fn();

  const panel = bindDfuController(
    mount,
    connectBtn,
    modePill,
    dfuGuideSection,
    setStatus
  );

  function q<T extends Element>(selector: string): T {
    return mount.querySelector<T>(selector)!;
  }

  return { panel, mount, connectBtn, modePill, dfuGuideSection, setStatus, q };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function connectAndReady(panel: ReturnType<typeof makePanel>['panel']) {
  await panel.connect(FAKE_PORT);
  latestTransport.simulateIncoming(
    okStateFrame([{ slot: 0, version: '1.0.0+0', active: true }])
  );
  await flush();
}

function injectFakeFile(
  fileInput: HTMLInputElement,
  content: string,
  name: string
) {
  const file = new File([content], name);
  Object.defineProperty(fileInput, 'files', {
    value: {
      0: file,
      length: 1,
      item: (i: number) => (i === 0 ? file : null),
    },
    configurable: true,
  });
  fileInput.dispatchEvent(new Event('change'));
}

// ── Teardown ──────────────────────────────────────────────────────────────────

afterEach(() => {
  document.body.innerHTML = '';
  capturedDfuSession = null;
  runImpl = async () => {};
  connectError = null;
  parseImageInfoImpl = () =>
    Promise.resolve({
      imageSize: 1,
      version: '1.2.3+0',
      sha256: new Uint8Array(32),
    });
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('connect → device info', () => {
  it('shows dfuDeviceSuccess and populates version when device responds', async () => {
    const { panel, q } = makePanel();

    await panel.connect(FAKE_PORT);

    latestTransport.simulateIncoming(
      okStateFrame([{ slot: 0, version: '2.1.0+42', active: true }])
    );
    await flush();

    expect(q('#dfuDeviceSuccess').classList.contains('hidden')).toBe(false);
    expect(q('#dfuDeviceVersion').textContent).toBe('2.1.0+42');
  });

  it('shows dfuNotBootloader when device responds with a non-zero error code', async () => {
    const { panel, q } = makePanel();

    await panel.connect(FAKE_PORT);

    latestTransport.simulateIncoming(errorFrame(5));
    await flush();

    expect(q('#dfuNotBootloader').classList.contains('hidden')).toBe(false);
  });

  it('shows dfuNotBootloader after 3 s with no response', async () => {
    vi.useFakeTimers();
    const { panel, q } = makePanel();

    await panel.connect(FAKE_PORT);
    await vi.advanceTimersByTimeAsync(3000);
    await flush();

    expect(q('#dfuNotBootloader').classList.contains('hidden')).toBe(false);
  });
});

describe('file selection', () => {
  it('shows image-info section for a valid firmware file', async () => {
    const { panel, q } = makePanel();
    await connectAndReady(panel);

    injectFakeFile(q<HTMLInputElement>('#dfuFileInput'), 'bin-data', 'fw.bin');
    await flush();
    await flush();

    expect(q('#dfuImageInfo').classList.contains('hidden')).toBe(false);
    expect(q('#dfuImageInfoVersion').textContent).toBe('1.2.3+0');
  });

  it('shows dfuFileError for an invalid firmware file', async () => {
    parseImageInfoImpl = () =>
      Promise.reject(new Error('Invalid image (wrong magic bytes)'));

    const { panel, q } = makePanel();
    await connectAndReady(panel);

    injectFakeFile(q<HTMLInputElement>('#dfuFileInput'), 'bad', 'bad.bin');
    await flush();
    await flush();

    expect(q('#dfuFileError').classList.contains('hidden')).toBe(false);
    expect(q<HTMLParagraphElement>('#dfuFileError').textContent).toContain(
      'Invalid image'
    );
  });
});

describe('flash cycle', () => {
  async function connectAndSelectFile(
    panel: ReturnType<typeof makePanel>['panel'],
    q: ReturnType<typeof makePanel>['q']
  ) {
    await connectAndReady(panel);
    injectFakeFile(q<HTMLInputElement>('#dfuFileInput'), 'bin-data', 'fw.bin');
    await flush();
    await flush();
  }

  it('applies done class and "Update complete" label when flash completes', async () => {
    const { panel, q } = makePanel();
    await connectAndSelectFile(panel, q);

    runImpl = async () => {
      capturedDfuSession!.onProgress?.({ phase: 'uploading', percentage: 100 });
      capturedDfuSession!.onProgress?.({ phase: 'done' });
    };

    q<HTMLButtonElement>('#dfuStartBtn').click();
    await flush();
    await flush();

    expect(q('#dfuProgressFill').className).toContain('bg-emerald-500');
    expect(q('#dfuProgressLabel').textContent).toBe('Update complete');
  });

  it('shows error phase when flash session throws', async () => {
    const { panel, q } = makePanel();
    await connectAndSelectFile(panel, q);

    runImpl = async () => {
      capturedDfuSession!.onProgress?.({
        phase: 'error',
        errorMessage: 'Upload failed',
      });
      throw new Error('Upload failed');
    };

    q<HTMLButtonElement>('#dfuStartBtn').click();
    await flush();
    await flush();

    expect(q('#dfuProgressFill').className).toContain('bg-red-500');
    expect(q('#dfuProgressLabel').textContent).toContain('Upload failed');
  });

  it('makes dfuGuideSection visible when transport error occurs during flash', async () => {
    const { panel, q, dfuGuideSection } = makePanel();
    await connectAndSelectFile(panel, q);

    let runResolve!: () => void;
    runImpl = () =>
      new Promise<void>((resolve) => {
        runResolve = resolve;
      });

    q<HTMLButtonElement>('#dfuStartBtn').click();
    // startDfu is suspended at await session.run(); runResolve is now set

    latestTransport.simulateError(new Error('USB cable disconnected'));
    await flush();

    expect(dfuGuideSection.classList.contains('hidden')).toBe(false);

    runResolve(); // let startDfu's run() resolve so the test finishes cleanly
    await flush();
  });
});

// ── Double-click guard ────────────────────────────────────────────────────────

describe('double-click guard on dfuStartBtn', () => {
  it('clicking dfuStartBtn a second time while disabled does not start a second DFU', async () => {
    const { panel, q } = makePanel();
    await connectAndReady(panel);

    injectFakeFile(q<HTMLInputElement>('#dfuFileInput'), 'bin-data', 'fw.bin');
    await flush();
    await flush();

    let sessionCount = 0;
    runImpl = async () => {
      sessionCount++;
      // Hold so we can fire the second click while the first is in-flight
      await new Promise<void>((r) => setTimeout(r, 100));
    };

    const btn = q<HTMLButtonElement>('#dfuStartBtn');
    btn.click(); // first click — startDfu() starts, btn.disabled = true
    btn.click(); // second click — should be ignored (btn.disabled is true)
    await flush();

    expect(sessionCount).toBe(1);
  });
});

// ── onError re-arm: transport error fires during query ────────────────────────

describe('queryDeviceInfo — onError ordering and re-arm', () => {
  it('transport error during query shows dfuNotBootloader (query error path, transport still connected)', async () => {
    // onError is registered BEFORE onFrame in queryDeviceInfo (the architectural
    // fix). This means if the transport fires an error before any frame arrives,
    // the queryErrorHandler receives it, re-arms onError, and shows "not bootloader".
    const { panel, q } = makePanel();
    await panel.connect(FAKE_PORT);
    // onError is now the queryErrorHandler (registered first in queryDeviceInfo)

    latestTransport.simulateError(new Error('early disconnect'));
    await flush();
    await flush();

    // Since transport.connected is still true in MockSmpTransport (simulateError
    // does not call disconnect()), the .catch() branch shows "not bootloader"
    expect(q('#dfuNotBootloader').classList.contains('hidden')).toBe(false);
  });

  it('transport error during query re-arms onError with the disconnect handler', async () => {
    // After the query error path, a SUBSEQUENT transport error should trigger
    // the disconnect handler (not another query-error cycle).
    const { panel, dfuGuideSection } = makePanel();
    await panel.connect(FAKE_PORT);

    latestTransport.simulateError(new Error('query error'));
    await flush();
    await flush();
    // At this point onError is re-armed with the disconnect handler

    latestTransport.simulateError(new Error('post-query error'));
    await flush();

    expect(dfuGuideSection.classList.contains('hidden')).toBe(false);
  });
});

// ── Progress phases: erasing and testing ─────────────────────────────────────

describe('progress phases', () => {
  async function connectAndSelectFile(
    panel: ReturnType<typeof makePanel>['panel'],
    q: ReturnType<typeof makePanel>['q']
  ) {
    await connectAndReady(panel);
    injectFakeFile(q<HTMLInputElement>('#dfuFileInput'), 'bin-data', 'fw.bin');
    await flush();
    await flush();
  }

  it('shows Erasing label and indeterminate style during erasing phase', async () => {
    const { panel, q } = makePanel();
    await connectAndSelectFile(panel, q);

    let resolveRun!: () => void;
    runImpl = async () => {
      capturedDfuSession!.onProgress?.({ phase: 'erasing' });
      await new Promise<void>((r) => {
        resolveRun = r;
      });
    };

    q<HTMLButtonElement>('#dfuStartBtn').click();
    // onProgress fires synchronously inside runImpl before its first await

    expect(q('#dfuProgressLabel').textContent).toBe('Erasing…');
    expect(q('#dfuProgressFill').className).toContain('animate-pulse');

    resolveRun();
    await flush();
  });

  it('shows Finalising label and indeterminate style during testing phase', async () => {
    const { panel, q } = makePanel();
    await connectAndSelectFile(panel, q);

    let resolveRun!: () => void;
    runImpl = async () => {
      capturedDfuSession!.onProgress?.({ phase: 'testing' });
      await new Promise<void>((r) => {
        resolveRun = r;
      });
    };

    q<HTMLButtonElement>('#dfuStartBtn').click();

    expect(q('#dfuProgressLabel').textContent).toBe('Finalising…');
    expect(q('#dfuProgressFill').className).toContain('animate-pulse');

    resolveRun();
    await flush();
  });
});

// ── handleFileChange with no file ─────────────────────────────────────────────

describe('handleFileChange — no file selected', () => {
  it('dispatching change with no file leaves dfuImageInfo hidden', async () => {
    const { q } = makePanel();

    // dfuFileInput.files is empty by default; dispatching change triggers
    // handleFileChange which returns early at the !file guard
    q<HTMLInputElement>('#dfuFileInput').dispatchEvent(new Event('change'));
    await flush();

    expect(q('#dfuImageInfo').classList.contains('hidden')).toBe(true);
  });
});

// ── resetFileSelection ────────────────────────────────────────────────────────

describe('resetFileSelection()', () => {
  it('hides dfuImageInfo and dfuFileError, clears selectedImage, and disables start button', async () => {
    const { panel, q } = makePanel();
    await connectAndReady(panel);

    // Inject a valid file so dfuImageInfo becomes visible
    injectFakeFile(q<HTMLInputElement>('#dfuFileInput'), 'bin-data', 'fw.bin');
    await flush();
    await flush();

    expect(q('#dfuImageInfo').classList.contains('hidden')).toBe(false);

    panel.resetFileSelection();

    expect(q('#dfuImageInfo').classList.contains('hidden')).toBe(true);
    expect(q('#dfuFileError').classList.contains('hidden')).toBe(true);
    expect(q<HTMLButtonElement>('#dfuStartBtn').disabled).toBe(true);
  });
});

// ── connect() error handling ──────────────────────────────────────────────────

describe('connect() error handling', () => {
  it('NotFoundError re-enables connectBtn without calling setStatus with error', async () => {
    const { panel, connectBtn, setStatus } = makePanel();
    connectBtn.disabled = true;

    connectError = new DOMException(
      'User cancelled port selection',
      'NotFoundError'
    );
    await panel.connect(FAKE_PORT);

    expect(connectBtn.disabled).toBe(false);
    // setStatus should NOT have been called with 'error' (NotFoundError is silent)
    const errorCall = (setStatus as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1] === 'error'
    );
    expect(errorCall).toBeUndefined();
  });

  it('generic connect error calls setStatus with "Connection failed" and re-enables connectBtn', async () => {
    const { panel, connectBtn, setStatus } = makePanel();

    connectError = new Error('USB device not accessible');
    await panel.connect(FAKE_PORT);

    expect(connectBtn.disabled).toBe(false);
    expect(setStatus).toHaveBeenCalledWith(
      expect.stringContaining('Connection failed'),
      'error'
    );
  });
});
