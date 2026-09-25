import {
  SerialSmpTransport,
  DfuSession,
  type DfuProgress,
  parseImageInfo,
  buildImageStateRequest,
  parseImageStateResponse,
} from '../protocol/mcumgr';
import { getRequiredElement } from './dom';
import { renderDfuSteps } from './dfu-steps';
import { BTN_CONNECT, BTN_DISCONNECT } from './button-classes';

const PROGRESS_INDETERMINATE =
  'h-full rounded-full bg-blue-400 animate-pulse transition-all duration-300';
const PROGRESS_UPLOADING =
  'h-full rounded-full bg-blue-500 transition-all duration-300';
const PROGRESS_DONE =
  'h-full rounded-full bg-emerald-500 transition-all duration-300';
const PROGRESS_ERROR =
  'h-full rounded-full bg-red-500 transition-all duration-300';

const DFU_SECTION_HTML = `
<div id="dfuDeviceCard" class="rounded-xl border border-neutral-200 bg-white p-4 space-y-2 dark:border-neutral-800 dark:bg-neutral-900">
  <div id="dfuDeviceLoading" class="flex items-center gap-2">
    <span class="status-indicator status-loading" aria-hidden="true"></span>
    <span class="text-sm text-neutral-500 dark:text-neutral-400">Reading device info…</span>
  </div>
  <div id="dfuDeviceSuccess" class="hidden">
    <div class="flex items-center gap-1.5 mb-2">
      <span class="status-indicator status-success" aria-hidden="true"></span>
      <span class="text-sm font-medium text-neutral-700 dark:text-neutral-300">Device ready</span>
    </div>
    <dl class="text-xs space-y-0.5 text-neutral-500 dark:text-neutral-400">
      <div class="flex justify-between gap-2">
        <dt class="font-medium text-neutral-600 dark:text-neutral-300">Version</dt>
        <dd id="dfuDeviceVersion"></dd>
      </div>
      <div class="flex justify-between gap-2">
        <dt class="font-medium text-neutral-600 dark:text-neutral-300">Status</dt>
        <dd id="dfuDeviceStatus"></dd>
      </div>
    </dl>
  </div>
  <div id="dfuNotBootloader" class="hidden">
    <div class="flex items-center gap-1.5 mb-2">
      <span class="status-indicator status-error" aria-hidden="true"></span>
      <span class="text-sm font-medium text-red-600 dark:text-red-400">Not in bootloader mode</span>
    </div>
    <p class="text-xs text-neutral-500 dark:text-neutral-400">
      Disconnect, hold the button while plugging in USB, then reconnect.
    </p>
  </div>
</div>
<div class="rounded-xl border border-neutral-200 bg-white p-4 space-y-3 dark:border-neutral-800 dark:bg-neutral-900">
  <span class="text-sm font-medium text-neutral-700 dark:text-neutral-300">Firmware file</span>
  <input type="file" id="dfuFileInput" accept=".bin" class="block w-full text-sm text-neutral-500 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100 dark:text-neutral-400 dark:file:bg-neutral-800 dark:file:text-neutral-300 disabled:opacity-40" />
  <p id="dfuFileError" class="hidden text-xs text-red-500 dark:text-red-400"></p>
  <dl id="dfuImageInfo" class="hidden text-xs space-y-0.5 text-neutral-500 dark:text-neutral-400">
    <div class="flex justify-between gap-2">
      <dt class="font-medium text-neutral-600 dark:text-neutral-300">File</dt>
      <dd id="dfuImageInfoName" class="truncate text-right max-w-[180px]"></dd>
    </div>
    <div class="flex justify-between gap-2">
      <dt class="font-medium text-neutral-600 dark:text-neutral-300">Size</dt>
      <dd id="dfuImageInfoSize"></dd>
    </div>
    <div class="flex justify-between gap-2">
      <dt class="font-medium text-neutral-600 dark:text-neutral-300">Version</dt>
      <dd id="dfuImageInfoVersion"></dd>
    </div>
  </dl>
</div>
<div>
  <button id="dfuStartBtn" disabled class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">
    Start Update
  </button>
</div>
<div id="dfuProgressContainer" class="hidden rounded-xl border border-neutral-200 bg-white p-4 space-y-2 dark:border-neutral-800 dark:bg-neutral-900">
  <div class="h-1.5 w-full rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
    <div id="dfuProgressFill" class="h-full rounded-full bg-blue-500 transition-all duration-300" style="width: 0%"></div>
  </div>
  <p id="dfuProgressLabel" class="text-xs text-neutral-500 dark:text-neutral-400"></p>
</div>`;

type StatusState = 'disconnected' | 'connected' | 'error';

export interface DfuPanel {
  readonly isConnected: boolean;
  connect(knownPort?: SerialPort): Promise<void>;
  disconnect(reason: string): Promise<void>;
  resetFileSelection(): void;
}

export function bindDfuController(
  mountContainer: HTMLElement,
  connectBtn: HTMLButtonElement,
  modePill: HTMLDivElement,
  dfuGuideSection: HTMLDivElement,
  setStatus: (text: string, state?: StatusState) => void
): DfuPanel {
  renderDfuSteps(getRequiredElement('dfuStepsMount'));

  mountContainer.classList.add('hidden', 'space-y-3');
  mountContainer.innerHTML = DFU_SECTION_HTML;
  const dfuSection = mountContainer as HTMLDivElement;

  function q<T extends Element>(id: string): T {
    return mountContainer.querySelector(`#${id}`) as T;
  }

  const dfuDeviceLoading = q<HTMLDivElement>('dfuDeviceLoading');
  const dfuDeviceSuccess = q<HTMLDivElement>('dfuDeviceSuccess');
  const dfuDeviceVersion = q<HTMLElement>('dfuDeviceVersion');
  const dfuDeviceStatus = q<HTMLElement>('dfuDeviceStatus');
  const dfuNotBootloader = q<HTMLDivElement>('dfuNotBootloader');
  const dfuFileInput = q<HTMLInputElement>('dfuFileInput');
  const dfuFileError = q<HTMLParagraphElement>('dfuFileError');
  const dfuImageInfo = q<HTMLDListElement>('dfuImageInfo');
  const dfuImageInfoName = q<HTMLElement>('dfuImageInfoName');
  const dfuImageInfoSize = q<HTMLElement>('dfuImageInfoSize');
  const dfuImageInfoVersion = q<HTMLElement>('dfuImageInfoVersion');
  const dfuStartBtn = q<HTMLButtonElement>('dfuStartBtn');
  const dfuProgressContainer = q<HTMLDivElement>('dfuProgressContainer');
  const dfuProgressFill = q<HTMLDivElement>('dfuProgressFill');
  const dfuProgressLabel = q<HTMLParagraphElement>('dfuProgressLabel');

  let transport: SerialSmpTransport | null = null;
  let selectedImage: { buffer: ArrayBuffer; name: string } | null = null;
  let deviceReady = false;

  // ── Utilities ─────────────────────────────────────────────────────────────

  function updateStartBtn(): void {
    dfuStartBtn.disabled = selectedImage === null || !deviceReady;
  }

  function updateProgress(p: DfuProgress): void {
    switch (p.phase) {
      case 'erasing':
        dfuProgressLabel.textContent = 'Erasing…';
        dfuProgressFill.style.width = '5%';
        dfuProgressFill.className = PROGRESS_INDETERMINATE;
        break;
      case 'uploading':
        dfuProgressLabel.textContent = `Uploading… ${p.percentage ?? 0}%`;
        dfuProgressFill.style.width = `${p.percentage ?? 0}%`;
        dfuProgressFill.className = PROGRESS_UPLOADING;
        break;
      case 'testing':
        dfuProgressLabel.textContent = 'Finalising…';
        dfuProgressFill.style.width = '100%';
        dfuProgressFill.className = PROGRESS_INDETERMINATE;
        break;
      case 'done':
        dfuProgressLabel.textContent = 'Update complete';
        dfuProgressFill.style.width = '100%';
        dfuProgressFill.className = PROGRESS_DONE;
        deviceReady = false;
        updateStartBtn();
        break;
      case 'error':
        dfuProgressLabel.textContent = p.errorMessage ?? 'Update failed';
        dfuProgressFill.className = PROGRESS_ERROR;
        break;
    }
  }

  // ── Device info query ─────────────────────────────────────────────────────

  function queryDeviceInfo(): void {
    if (!transport) return;

    const frame = buildImageStateRequest(0);
    let settled = false;

    void new Promise<Uint8Array>((resolve, reject) => {
      // onError is a single-slot setter — register it first so no window exists
      // where a transport error would go to the connect()-era handler instead.
      // Every branch that settles the promise re-arms the handler to disconnect.
      transport!.onError((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (transport) transport.onError((e) => void disconnect(e.message));
        reject(err);
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (transport) transport.onError((err) => void disconnect(err.message));
        reject(new Error('timeout'));
      }, 3000);

      transport!.onFrame((f) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (transport) transport.onError((err) => void disconnect(err.message));
        resolve(f);
      });

      transport!.send(frame).catch((err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (transport) transport.onError((e) => void disconnect(e.message));
        reject(err);
      });
    })
      .then((resp) => {
        const parsed = parseImageStateResponse(resp);
        const active =
          parsed.images.find((img) => img.active) ?? parsed.images[0];

        dfuDeviceVersion.textContent = active?.version ?? '—';
        dfuDeviceStatus.textContent = active?.confirmed
          ? 'Active'
          : 'Test boot pending';
        dfuDeviceLoading.classList.add('hidden');
        dfuDeviceSuccess.classList.remove('hidden');
        deviceReady = true;
        updateStartBtn();
      })
      .catch((err: unknown) => {
        if (transport !== null && !transport.connected) {
          void disconnect(err instanceof Error ? err.message : 'Disconnected');
          return;
        }
        // Re-arm the error handler — the reject closure installed during the
        // query is now settled and would silently swallow future transport errors.
        if (transport !== null) {
          transport.onError((e) => void disconnect(e.message));
        }
        console.warn(
          '[dfu] device info query failed — likely not in bootloader:',
          err
        );
        dfuDeviceLoading.classList.add('hidden');
        dfuNotBootloader.classList.remove('hidden');
      });
  }

  // ── File handling ─────────────────────────────────────────────────────────

  async function handleFileChange(): Promise<void> {
    const file = dfuFileInput.files?.[0];
    dfuImageInfo.classList.add('hidden');
    dfuFileError.classList.add('hidden');
    selectedImage = null;
    updateStartBtn();

    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const info = await parseImageInfo(buffer);
      selectedImage = { buffer, name: file.name };

      dfuImageInfoName.textContent = file.name;
      dfuImageInfoSize.textContent = `${(file.size / 1024).toFixed(1)} kB`;
      dfuImageInfoVersion.textContent = info.version;
      dfuImageInfo.classList.remove('hidden');
      updateStartBtn();
    } catch (err) {
      console.error('[dfu] failed to parse firmware file:', err);
      dfuFileError.textContent =
        err instanceof Error ? err.message : 'Invalid firmware file';
      dfuFileError.classList.remove('hidden');
    }
  }

  // ── DFU session ───────────────────────────────────────────────────────────

  async function startDfu(): Promise<void> {
    if (!transport || !selectedImage) return;

    dfuFileInput.disabled = true;
    dfuStartBtn.disabled = true;
    connectBtn.disabled = true;
    dfuProgressContainer.classList.remove('hidden');
    dfuProgressFill.style.width = '0%';
    dfuProgressFill.className = PROGRESS_UPLOADING;
    dfuProgressLabel.textContent = 'Starting…';

    const session = new DfuSession(transport);
    session.onProgress = (p) => updateProgress(p);

    try {
      await session.run(selectedImage.buffer);
    } catch (err) {
      console.error('[dfu] firmware update failed:', err);
      updateProgress({
        phase: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    } finally {
      connectBtn.disabled = false;
      if (transport !== null && !transport.connected) {
        void disconnect('Device disconnected');
      } else if (transport !== null) {
        transport.onError((err) => void disconnect(err.message));
        dfuFileInput.disabled = false;
        updateStartBtn();
      }
    }
  }

  dfuFileInput.addEventListener('change', () => void handleFileChange());
  dfuStartBtn.addEventListener('click', () => {
    if (dfuStartBtn.disabled) return;
    dfuStartBtn.disabled = true;
    void startDfu();
  });

  // ── Public API ────────────────────────────────────────────────────────────

  async function disconnect(reason: string): Promise<void> {
    const t = transport;
    if (t === null) return;
    transport = null;
    selectedImage = null;
    deviceReady = false;

    try {
      await t.disconnect();
    } catch {
      // best-effort
    }

    dfuSection.classList.add('hidden');
    dfuProgressContainer.classList.add('hidden');
    dfuProgressFill.style.width = '0%';
    dfuProgressFill.className = PROGRESS_UPLOADING;
    dfuFileInput.value = '';
    dfuFileInput.disabled = false;
    dfuImageInfo.classList.add('hidden');
    dfuFileError.classList.add('hidden');
    updateStartBtn();

    dfuGuideSection.classList.remove('hidden');
    modePill.classList.remove('hidden');

    setStatus(reason);
    connectBtn.textContent = 'Connect';
    connectBtn.className = BTN_CONNECT;
    connectBtn.disabled = false;
  }

  async function connect(knownPort?: SerialPort): Promise<void> {
    try {
      transport = new SerialSmpTransport(
        knownPort
          ? () => Promise.resolve(knownPort)
          : () => navigator.serial.requestPort(),
        115200
      );
      transport.onError((err) => void disconnect(err.message));
      await transport.connect();

      modePill.classList.add('hidden');
      dfuGuideSection.classList.add('hidden');
      dfuSection.classList.remove('hidden');

      dfuDeviceLoading.classList.remove('hidden');
      dfuDeviceSuccess.classList.add('hidden');
      dfuNotBootloader.classList.add('hidden');
      deviceReady = false;
      updateStartBtn();

      setStatus('Connected', 'connected');
      connectBtn.textContent = 'Disconnect';
      connectBtn.className = BTN_DISCONNECT;
      connectBtn.disabled = false;

      queryDeviceInfo();
    } catch (error) {
      transport = null;
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        connectBtn.disabled = false;
        return;
      }
      console.error('[dfu] connect failed:', error);
      setStatus(`Connection failed — ${error}`, 'error');
      connectBtn.disabled = false;
    }
  }

  return {
    get isConnected() {
      return transport !== null;
    },
    connect,
    disconnect,
    resetFileSelection(): void {
      selectedImage = null;
      dfuFileInput.value = '';
      dfuImageInfo.classList.add('hidden');
      dfuFileError.classList.add('hidden');
      updateStartBtn();
    },
  };
}
