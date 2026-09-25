import {
  CONFIG_CMD,
  TLV_TYPE,
  DIRECTION,
  GROUP,
} from '../../../protocol/command';
import { makeEnumSelectField, CARD, SELECT } from '../field-utils';
import type { FieldBinding, FieldContext } from '../field-utils';

export const directionHtml = `
<div id="directionSection" class="${CARD}">
  <div class="flex items-center justify-between">
    <span class="text-sm font-medium text-neutral-700 dark:text-neutral-300">Direction</span>
    <div class="flex items-center gap-1.5">
      <span id="directionStatus" class="status-indicator status-idle" aria-label="Direction status"></span>
      <span id="directionStatusText" class="text-xs text-neutral-400 dark:text-neutral-500"></span>
    </div>
  </div>
  <label class="sr-only" for="directionSelect">Direction</label>
  <select id="directionSelect" class="${SELECT}">
    <option value="0">Normal</option>
    <option value="1">Inverted</option>
  </select>
</div>`;

export function bindDirectionField(ctx: FieldContext): FieldBinding {
  return makeEnumSelectField(ctx, {
    sectionId: 'directionSection',
    selectId: 'directionSelect',
    statusId: 'directionStatus',
    statusTextId: 'directionStatusText',
    pollKey: `${GROUP.CONFIG}-${CONFIG_CMD.GET_DIRECTION}`,
    validValues: new Set<number>(Object.values(DIRECTION)),
    tlvType: TLV_TYPE.DIRECTION,
    setCmd: CONFIG_CMD.SET_DIRECTION,
    label: 'direction',
  });
}
