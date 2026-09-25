import './styles.css';
import { injectSvgSymbols } from './assets/symbols';
import { getRequiredElement } from './dom';
import { bindDfuController } from './dfu';
import { ConnectionManager } from './connection';
import { bindConfigPanel, type ConfigPanel } from './config/index';
import { POST_SYNC_SETTLE_MS } from './constants';
import { BTN_CONNECT, BTN_DISCONNECT } from './button-classes';

// ── App mode ──────────────────────────────────────────────────────────────────

type AppMode = 'config' | 'dfu';
let mode: AppMode = 'config';

// ── DOM refs ──────────────────────────────────────────────────────────────────

const connectBtn = getRequiredElement<HTMLButtonElement>('connectBtn');
const statusDot = getRequiredElement<HTMLSpanElement>('statusDot');
const statusSpan = getRequiredElement<HTMLSpanElement>('status');
const modePill = getRequiredElement<HTMLDivElement>('modePill');
const modeConfigBtn = getRequiredElement<HTMLButtonElement>('modeConfigBtn');
const modeDfuBtn = getRequiredElement<HTMLButtonElement>('modeDfuBtn');
const configGuideSection =
  getRequiredElement<HTMLDivElement>('configGuideSection');
const dfuGuideSection = getRequiredElement<HTMLDivElement>('dfuGuideSection');
const noSerialMsg = getRequiredElement<HTMLDivElement>('noSerialMsg');
const browserInfo = getRequiredElement<HTMLParagraphElement>('browserInfo');

const PILL_ACTIVE =
  'flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors bg-white shadow text-neutral-800 dark:bg-neutral-700 dark:shadow-none dark:text-neutral-100';
const PILL_INACTIVE =
  'flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-300';

// ── Status helper ─────────────────────────────────────────────────────────────

const DOT = {
  disconnected:
    'inline-block h-1.5 w-1.5 rounded-full bg-neutral-300 dark:bg-neutral-600',
  connected: 'inline-block h-1.5 w-1.5 rounded-full bg-emerald-500',
  error: 'inline-block h-1.5 w-1.5 rounded-full bg-red-500',
};

function setStatus(text: string, state: keyof typeof DOT = 'disconnected') {
  statusSpan.textContent = text;
  statusDot.className = DOT[state];
}

// ── Mode switching ────────────────────────────────────────────────────────────

function setMode(m: AppMode) {
  mode = m;
  modeConfigBtn.className = m === 'config' ? PILL_ACTIVE : PILL_INACTIVE;
  modeDfuBtn.className = m === 'dfu' ? PILL_ACTIVE : PILL_INACTIVE;
  configGuideSection.classList.toggle('hidden', m !== 'config');
  dfuGuideSection.classList.toggle('hidden', m !== 'dfu');
  dfu.resetFileSelection();
}

const dfu = bindDfuController(
  getRequiredElement('dfuMount'),
  connectBtn,
  modePill,
  dfuGuideSection,
  setStatus
);

// ── Config panel ──────────────────────────────────────────────────────────────

// configPanel is assigned immediately after conn — the ! assertion is safe because
// conn's callbacks are closures that only fire after user interaction (connect/sync).
let configPanel!: ConfigPanel;

const conn = new ConnectionManager({
  onConnected: () => {
    setStatus('Connected', 'connected');
    configGuideSection.classList.add('hidden');
    modePill.classList.add('hidden');
    configPanel.prepare();
    connectBtn.textContent = 'Disconnect';
    connectBtn.className = BTN_DISCONNECT;
    connectBtn.disabled = false;
  },
  onDisconnected: (reason) => {
    configPanel.cleanup();
    configGuideSection.classList.remove('hidden');
    modePill.classList.remove('hidden');
    setStatus(reason);
    connectBtn.textContent = 'Connect';
    connectBtn.className = BTN_CONNECT;
    connectBtn.disabled = false;
  },
  onSynced: () => {
    setTimeout(() => configPanel.onSynced(), POST_SYNC_SETTLE_MS);
  },
  onError: (message) => {
    setStatus(message, 'error');
  },
  onSmpDetected: async (port) => {
    await port.close();
    setMode('dfu');
    await dfu.connect(port);
  },
});

configPanel = bindConfigPanel(getRequiredElement('configPanel'), conn, (msg) =>
  setStatus(msg, 'error')
);

// ── Mode pill handlers ────────────────────────────────────────────────────────

modeConfigBtn.addEventListener('click', () => {
  if (!conn.connected && !dfu.isConnected) setMode('config');
});
modeDfuBtn.addEventListener('click', () => {
  if (!conn.connected && !dfu.isConnected) setMode('dfu');
});

// ── Connect / Disconnect toggle ───────────────────────────────────────────────

connectBtn.addEventListener('click', async () => {
  if (conn.connected) {
    connectBtn.disabled = true;
    void conn.disconnect('Disconnected');
    return;
  }
  if (dfu.isConnected) {
    connectBtn.disabled = true;
    void dfu.disconnect('Disconnected');
    return;
  }

  connectBtn.disabled = true;

  if (mode === 'config') {
    try {
      await conn.connect();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        connectBtn.disabled = false;
        return;
      }
      setStatus(`Connection failed — ${error}`, 'error');
      connectBtn.disabled = false;
    }
  } else {
    await dfu.connect();
  }
});

// ── Browser info ──────────────────────────────────────────────────────────────

function detectBrowser(): string {
  const ua = navigator.userAgent;
  let m: RegExpMatchArray | null;
  if ((m = ua.match(/Edg\/(\d+)/))) return `Edge ${m[1]}`;
  if ((m = ua.match(/OPR\/(\d+)/))) return `Opera ${m[1]}`;
  if ((m = ua.match(/Chrome\/(\d+)/))) return `Chrome ${m[1]}`;
  if ((m = ua.match(/Firefox\/(\d+)/))) return `Firefox ${m[1]}`;
  if ((m = ua.match(/Version\/(\d+).*Safari/))) return `Safari ${m[1]}`;
  return 'Unknown browser';
}

const serialSupported = 'serial' in navigator;
browserInfo.textContent = `${detectBrowser()} · Web Serial: ${serialSupported ? '✓' : '✗'}`;

if (!serialSupported) {
  connectBtn.disabled = true;
  noSerialMsg.classList.remove('hidden');
  setStatus('Not supported', 'error');
}

// ── Startup ───────────────────────────────────────────────────────────────────

injectSvgSymbols();
setMode('config');
