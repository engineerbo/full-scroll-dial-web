import {
  CONFIG_CMD,
  TLV_TYPE,
  SCROLL_MODE,
  GROUP,
} from '../../../protocol/command';
import { makeEnumSelectField, CARD, SELECT } from '../field-utils';
import type { FieldBinding, FieldContext } from '../field-utils';
import { infoTip } from '../../info-tip';

export const scrollModeHtml = `
<div id="scrollModeSection" class="${CARD}">
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-1.5">
      <span class="text-sm font-medium text-neutral-700 dark:text-neutral-300">Scroll Mode</span>
      ${infoTip(
        'scrollModeInfo',
        `<ul>
          <li><strong>Standard</strong>: Scrolls in whole wheel notches, like a regular mouse. Some DICOM viewers work better in this mode.</li>
          <li><strong>High-Resolution</strong>: Sends fine-grained steps for smooth scrolling in apps that support it.</li>
        </ul>`
      )}
    </div>
    <div class="flex items-center gap-1.5">
      <span id="scrollModeStatus" class="status-indicator status-idle" aria-label="Scroll mode status"></span>
      <span id="scrollModeStatusText" class="text-xs text-neutral-400 dark:text-neutral-500"></span>
    </div>
  </div>
  <label class="sr-only" for="scrollModeSelect">Scroll Mode</label>
  <select id="scrollModeSelect" class="${SELECT}">
    <option value="0">Standard</option>
    <option value="1">High-Resolution</option>
  </select>
</div>`;

export function bindScrollModeField(ctx: FieldContext): FieldBinding {
  return makeEnumSelectField(ctx, {
    sectionId: 'scrollModeSection',
    selectId: 'scrollModeSelect',
    statusId: 'scrollModeStatus',
    statusTextId: 'scrollModeStatusText',
    pollKey: `${GROUP.CONFIG}-${CONFIG_CMD.GET_SCROLL_MODE}`,
    validValues: new Set<number>(Object.values(SCROLL_MODE)),
    tlvType: TLV_TYPE.SCROLL_MODE,
    setCmd: CONFIG_CMD.SET_SCROLL_MODE,
    label: 'scroll mode',
  });
}
