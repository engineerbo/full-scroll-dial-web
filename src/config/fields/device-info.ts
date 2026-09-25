import { GROUP, CORE_CMD } from '../../../protocol/command';
import { CARD } from '../field-utils';
import type { FieldBinding, FieldContext } from '../field-utils';

const FW_KEY = `${GROUP.CORE}-${CORE_CMD.GET_FW_VERSION}`;
const HW_KEY = `${GROUP.CORE}-${CORE_CMD.GET_HW_VERSION}`;
const SERIAL_KEY = `${GROUP.CORE}-${CORE_CMD.GET_SERIAL}`;

export const deviceInfoHtml = `
<div id="deviceInfoSection" class="${CARD}">
  <span class="text-sm font-medium text-neutral-700 dark:text-neutral-300">Device</span>
  <dl class="space-y-1.5">
    <div id="fwVersionRow" class="hidden flex items-center justify-between">
      <dt class="text-xs text-neutral-500 dark:text-neutral-400">Firmware Version</dt>
      <dd id="fwVersionValue" class="text-xs font-mono text-neutral-700 dark:text-neutral-300"></dd>
    </div>
    <div id="hwVersionRow" class="hidden flex items-center justify-between">
      <dt class="text-xs text-neutral-500 dark:text-neutral-400">Hardware Version</dt>
      <dd id="hwVersionValue" class="text-xs font-mono text-neutral-700 dark:text-neutral-300"></dd>
    </div>
    <div id="serialRow" class="hidden flex items-center justify-between">
      <dt class="text-xs text-neutral-500 dark:text-neutral-400">Serial</dt>
      <dd id="serialValue" class="text-xs font-mono text-neutral-700 dark:text-neutral-300"></dd>
    </div>
  </dl>
</div>`;

function decodeVersionString(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;

  // If every byte is printable ASCII (0x20–0x7E) or a null terminator → C string path.
  // Strip trailing nulls first, then decode as text.
  if (bytes.every((b) => b === 0 || (b >= 0x20 && b <= 0x7e))) {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    if (end === 0) return null;
    const text = new TextDecoder().decode(bytes.subarray(0, end)).trim();
    return text.length > 0 ? text : null;
  }

  // Binary version data — zeros are valid version components, so do NOT strip them.
  // [major, minor, patch] → "major.minor.patch"
  return Array.from(bytes).join('.');
}

export function bindDeviceInfoField(ctx: FieldContext): FieldBinding {
  const { container } = ctx;
  const q = <T extends Element>(id: string): T =>
    container.querySelector(`#${id}`) as T;

  const section = q<HTMLDivElement>('deviceInfoSection');
  const fwRow = q<HTMLDivElement>('fwVersionRow');
  const hwRow = q<HTMLDivElement>('hwVersionRow');
  const serialRow = q<HTMLDivElement>('serialRow');
  const fwValue = q<HTMLElement>('fwVersionValue');
  const hwValue = q<HTMLElement>('hwVersionValue');
  const serialValue = q<HTMLElement>('serialValue');

  function tryShow(
    row: HTMLElement,
    valueEl: HTMLElement,
    bytes: Uint8Array | undefined,
    shown: Set<string>,
    key: string,
    prefix = ''
  ): void {
    if (shown.has(key) || bytes === undefined) return;
    const text = decodeVersionString(bytes);
    if (text === null) return;
    valueEl.textContent = prefix + text;
    row.classList.remove('hidden');
    section.classList.remove('hidden');
    shown.add(key);
  }

  return {
    activate() {
      const shown = new Set<string>();
      return (entries) => {
        tryShow(fwRow, fwValue, entries.get(FW_KEY), shown, FW_KEY, 'v');
        tryShow(hwRow, hwValue, entries.get(HW_KEY), shown, HW_KEY);
        tryShow(
          serialRow,
          serialValue,
          entries.get(SERIAL_KEY),
          shown,
          SERIAL_KEY
        );
      };
    },

    cleanup() {
      section.classList.add('hidden');
      fwRow.classList.add('hidden');
      hwRow.classList.add('hidden');
      serialRow.classList.add('hidden');
      fwValue.textContent = '';
      hwValue.textContent = '';
      serialValue.textContent = '';
    },
  };
}
