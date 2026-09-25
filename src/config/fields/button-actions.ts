import {
  GROUP,
  CONFIG_CMD,
  TLV_TYPE,
  BUTTON_ACTION,
  encodeTlv,
} from '../../../protocol/command';
import { makeSaver } from '../../save-command';
import { checkPoll, makeFieldCallback, CARD, SELECT } from '../field-utils';
import type { FieldBinding, FieldContext } from '../field-utils';

const BUTTON_OPTIONS = `
    <option value="0">Cycle Sensitivity</option>
    <option value="1">Toggle Direction</option>
    <option value="2">Toggle Scroll Mode</option>
    <option value="255">Disabled</option>`;

export const buttonActionsHtml = `
<div id="buttonPressSection" class="${CARD}">
  <div class="flex items-center justify-between">
    <span class="text-sm font-medium text-neutral-700 dark:text-neutral-300">Button press</span>
    <div class="flex items-center gap-1.5">
      <span id="buttonPressStatus" class="status-indicator status-idle" aria-label="Button press status"></span>
      <span id="buttonPressStatusText" class="text-xs text-neutral-400 dark:text-neutral-500"></span>
    </div>
  </div>
  <label class="sr-only" for="buttonPressSelect">Button press action</label>
  <select id="buttonPressSelect" class="${SELECT}">${BUTTON_OPTIONS}
  </select>
</div>
<div id="buttonLongpressSection" class="${CARD}">
  <div class="flex items-center justify-between">
    <span class="text-sm font-medium text-neutral-700 dark:text-neutral-300">Button long-press</span>
    <div class="flex items-center gap-1.5">
      <span id="buttonLongpressStatus" class="status-indicator status-idle" aria-label="Button long-press status"></span>
      <span id="buttonLongpressStatusText" class="text-xs text-neutral-400 dark:text-neutral-500"></span>
    </div>
  </div>
  <label class="sr-only" for="buttonLongpressSelect">Button long-press action</label>
  <select id="buttonLongpressSelect" class="${SELECT}">${BUTTON_OPTIONS}
  </select>
</div>`;

const VALID_BUTTON_ACTIONS = new Set<number>([
  BUTTON_ACTION.CYCLE_SENSITIVITY,
  BUTTON_ACTION.TOGGLE_DIRECTION,
  BUTTON_ACTION.TOGGLE_SCROLL_MODE,
  BUTTON_ACTION.DISABLED,
]);

function bindButtonSelect(
  ctx: FieldContext,
  section: HTMLDivElement,
  select: HTMLSelectElement,
  dot: HTMLSpanElement,
  text: HTMLSpanElement,
  pollKey: string,
  tlvType: number,
  setCmd: number,
  label: string
): {
  cancelSave: () => void;
  getPollCallback: () => (entries: Map<string, Uint8Array>) => void;
} {
  const { conn, getPoller, pollLastSeen } = ctx;
  const { save, cleanup: cancelSave } = makeSaver(
    getPoller,
    () => conn.protocol,
    GROUP.CONFIG,
    setCmd,
    dot,
    text,
    label
  );

  select.addEventListener('change', () => {
    const action = parseInt(select.value, 10);
    if (!VALID_BUTTON_ACTIONS.has(action)) return;
    save(encodeTlv(tlvType, new Uint8Array([action])), () => {
      pollLastSeen.set(pollKey, action);
    });
  });

  function getPollCallback(): (entries: Map<string, Uint8Array>) => void {
    const onValue = makeFieldCallback(
      section,
      (v) => {
        select.value = v.toString();
      },
      dot,
      text
    );
    return (entries) => checkPoll(entries, pollKey, 0, pollLastSeen, onValue);
  }

  return { cancelSave, getPollCallback };
}

export function bindButtonActionsField(ctx: FieldContext): FieldBinding {
  const { container } = ctx;
  const q = <T extends Element>(id: string): T =>
    container.querySelector(`#${id}`) as T;

  const pressSection = q<HTMLDivElement>('buttonPressSection');
  const pressSelect = q<HTMLSelectElement>('buttonPressSelect');
  const pressDot = q<HTMLSpanElement>('buttonPressStatus');
  const pressText = q<HTMLSpanElement>('buttonPressStatusText');
  const longpressSection = q<HTMLDivElement>('buttonLongpressSection');
  const longpressSelect = q<HTMLSelectElement>('buttonLongpressSelect');
  const longpressDot = q<HTMLSpanElement>('buttonLongpressStatus');
  const longpressText = q<HTMLSpanElement>('buttonLongpressStatusText');

  const pressKey = `${GROUP.CONFIG}-${CONFIG_CMD.GET_BUTTON_PRESS}`;
  const longpressKey = `${GROUP.CONFIG}-${CONFIG_CMD.GET_BUTTON_LONGPRESS}`;

  const press = bindButtonSelect(
    ctx,
    pressSection,
    pressSelect,
    pressDot,
    pressText,
    pressKey,
    TLV_TYPE.BUTTON_PRESS,
    CONFIG_CMD.SET_BUTTON_PRESS,
    'button press action'
  );
  const longpress = bindButtonSelect(
    ctx,
    longpressSection,
    longpressSelect,
    longpressDot,
    longpressText,
    longpressKey,
    TLV_TYPE.BUTTON_LONGPRESS,
    CONFIG_CMD.SET_BUTTON_LONGPRESS,
    'button long-press action'
  );

  return {
    activate() {
      const pressPoll = press.getPollCallback();
      const longpressPoll = longpress.getPollCallback();
      return (entries) => {
        pressPoll(entries);
        longpressPoll(entries);
      };
    },
    cleanup() {
      press.cancelSave();
      longpress.cancelSave();
      pressSection.classList.add('hidden');
      longpressSection.classList.add('hidden');
    },
  };
}
