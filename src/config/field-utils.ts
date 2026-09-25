import { encodeTlv, GROUP } from '../../protocol/command';
import { setFieldStatus } from '../field-status';
import { makeSaver } from '../save-command';
import type { Poller } from '../poller';
import type { ConnectionManager } from '../connection';

export const CARD =
  'hidden rounded-xl border border-neutral-200 bg-white p-4 space-y-3 dark:border-neutral-800 dark:bg-neutral-900';
export const SELECT =
  'w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100';

export interface FieldContext {
  container: HTMLElement;
  conn: ConnectionManager;
  getPoller(): Poller | null;
  pollLastSeen: Map<string, number>;
}

export interface FieldBinding {
  /** Called on each successful sync: (re)creates poll callbacks. Returns poll handler. */
  activate(): (entries: Map<string, Uint8Array>) => void;
  /** Called on disconnect: tears down sliders, hides sections, resets local state. */
  cleanup(): void;
}

export function checkPoll(
  entries: Map<string, Uint8Array>,
  key: string,
  defaultValue: number,
  pollLastSeen: Map<string, number>,
  onValue: (v: number) => void
): void {
  const entry = entries.get(key);
  if (!entry) return;
  const value = entry[0] ?? defaultValue;
  if (pollLastSeen.get(key) !== value) {
    pollLastSeen.set(key, value);
    onValue(value);
  }
}

/** Builds a poll callback that reveals the section on first call and shows "Updated" thereafter. */
export function makeFieldCallback(
  section: HTMLDivElement,
  setter: (v: number) => void,
  dot: HTMLSpanElement,
  text: HTMLSpanElement
): (v: number) => void {
  let loaded = false;
  return (v) => {
    setter(v);
    section.classList.remove('hidden');
    if (loaded) {
      setFieldStatus(dot, text, 'success', 'Updated', true);
    }
    loaded = true;
  };
}

export interface EnumSelectFieldConfig {
  sectionId: string;
  selectId: string;
  statusId: string;
  statusTextId: string;
  /** Poll map key, e.g. `${GROUP.CONFIG}-${CONFIG_CMD.GET_DIRECTION}`. */
  pollKey: string;
  validValues: Set<number>;
  tlvType: number;
  setCmd: number;
  label: string;
}

/**
 * Factory for simple single-select config fields.
 * Handles element lookup, save wiring, change listener, poll callback, and cleanup.
 */
export function makeEnumSelectField(
  ctx: FieldContext,
  config: EnumSelectFieldConfig
): FieldBinding {
  const { container, conn, getPoller, pollLastSeen } = ctx;
  const q = <T extends Element>(id: string): T =>
    container.querySelector(`#${id}`) as T;

  const section = q<HTMLDivElement>(config.sectionId);
  const select = q<HTMLSelectElement>(config.selectId);
  const dot = q<HTMLSpanElement>(config.statusId);
  const text = q<HTMLSpanElement>(config.statusTextId);

  const { save, cleanup: cancelSave } = makeSaver(
    getPoller,
    () => conn.protocol,
    GROUP.CONFIG,
    config.setCmd,
    dot,
    text,
    config.label
  );

  select.addEventListener('change', () => {
    const value = parseInt(select.value, 10);
    if (!config.validValues.has(value)) return;
    save(encodeTlv(config.tlvType, new Uint8Array([value])), () => {
      pollLastSeen.set(config.pollKey, value);
    });
  });

  return {
    activate() {
      const onValue = makeFieldCallback(
        section,
        (v) => {
          select.value = v.toString();
        },
        dot,
        text
      );
      return (entries) =>
        checkPoll(entries, config.pollKey, 0, pollLastSeen, onValue);
    },
    cleanup() {
      cancelSave();
      section.classList.add('hidden');
    },
  };
}
