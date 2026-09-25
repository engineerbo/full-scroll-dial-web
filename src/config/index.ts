import {
  GROUP,
  CORE_CMD,
  PROTOCOL_VERSION,
  RESPONSE_STATUS,
  parseGetAllStates,
} from '../../protocol/command';
import type { CommandProtocol } from '../../protocol/command';
import { Poller } from '../poller';
import type { ConnectionManager } from '../connection';
import type { FieldContext } from './field-utils';
import { POLL_INTERVAL_MS } from '../constants';
import { deviceInfoHtml, bindDeviceInfoField } from './fields/device-info';
import { scrollModeHtml, bindScrollModeField } from './fields/scroll-mode';
import {
  buttonActionsHtml,
  bindButtonActionsField,
} from './fields/button-actions';
import { directionHtml, bindDirectionField } from './fields/direction';
import { sensitivityHtml, bindSensitivityFields } from './fields/sensitivity';
import { backlashHtml, bindBacklashField } from './fields/backlash';
import { selfTestHtml, bindSelfTestField } from './fields/self-test';

const LOADING_HTML = `
<div id="configLoadingSection" class="hidden rounded-xl border border-neutral-200 bg-white p-4 flex items-center gap-2 dark:border-neutral-800 dark:bg-neutral-900">
  <span class="status-indicator status-loading" aria-hidden="true"></span>
  <span class="text-sm text-neutral-500 dark:text-neutral-400">Loading device settings…</span>
</div>`;

const CARDS_HTML =
  LOADING_HTML +
  deviceInfoHtml +
  scrollModeHtml +
  buttonActionsHtml +
  directionHtml +
  sensitivityHtml +
  backlashHtml +
  selfTestHtml;

export interface ConfigPanel {
  prepare(): void;
  onSynced(): void;
  cleanup(): void;
}

export function bindConfigPanel(
  container: HTMLElement,
  conn: ConnectionManager,
  onInitError: (message: string) => void
): ConfigPanel {
  container.innerHTML = CARDS_HTML;

  const configLoadingSection = container.querySelector(
    '#configLoadingSection'
  ) as HTMLDivElement;

  const pollLastSeen = new Map<string, number>();
  let poller: Poller | null = null;
  let responseHandler:
    | ((g: number, c: number, status: number, data: Uint8Array) => void)
    | null = null;
  let registeredProtocol: CommandProtocol | null = null;

  const ctx: FieldContext = {
    container,
    conn,
    getPoller: () => poller,
    pollLastSeen,
  };

  const deviceInfoBinding = bindDeviceInfoField(ctx);
  const scrollModeBinding = bindScrollModeField(ctx);
  const buttonActionsBinding = bindButtonActionsField(ctx);
  const directionBinding = bindDirectionField(ctx);
  const sensitivityBinding = bindSensitivityFields(ctx);
  const backlashBinding = bindBacklashField(ctx);
  const selfTestBinding = bindSelfTestField(ctx);

  function syncAndBind(): void {
    const protocol = conn.protocol;
    if (!protocol) return;

    if (responseHandler && registeredProtocol) {
      registeredProtocol.off('response', responseHandler);
      registeredProtocol = null;
      responseHandler = null;
    }
    poller?.stop();
    poller = null;
    pollLastSeen.clear();

    const pollHandlers = [
      deviceInfoBinding.activate(),
      scrollModeBinding.activate(),
      buttonActionsBinding.activate(),
      directionBinding.activate(),
      sensitivityBinding.activate(),
      backlashBinding.activate(),
      selfTestBinding.activate(),
    ];

    const versionPayload = new Uint8Array([
      PROTOCOL_VERSION & 0xff,
      (PROTOCOL_VERSION >> 8) & 0xff,
    ]);

    responseHandler = (g, c, status, data) => {
      if (g === GROUP.CORE && c === CORE_CMD.GET_PROTOCOL_VERSION) {
        if (data.length >= 2) {
          const negotiatedVersion = data[0]! | (data[1]! << 8);
          if (negotiatedVersion !== PROTOCOL_VERSION) {
            console.warn(
              `Protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${negotiatedVersion}`
            );
          }
        }
        // Start polling only after GET_PROTOCOL_VERSION is acknowledged —
        // the reliable-serial layer rejects a second send while the first
        // frame is still awaiting acknowledgement.
        if (!poller) {
          poller = new Poller(() => {
            protocol.send(GROUP.CORE, CORE_CMD.GET_ALL_STATES);
          }, POLL_INTERVAL_MS);
          poller.start(conn.signal ?? undefined);
        }
      }
      if (g === GROUP.CORE && c === CORE_CMD.GET_ALL_STATES) {
        configLoadingSection.classList.add('hidden');
        if (status === RESPONSE_STATUS.SUCCESS) {
          const entries = parseGetAllStates(data);
          for (const handler of pollHandlers) handler(entries);
        } else {
          onInitError(
            `Init failed — GET_ALL_STATES returned error status 0x${status.toString(16).padStart(2, '0')}`
          );
        }
      }
    };

    registeredProtocol = protocol;
    protocol.on('response', responseHandler);
    protocol.send(GROUP.CORE, CORE_CMD.GET_PROTOCOL_VERSION, versionPayload);
  }

  return {
    prepare(): void {
      configLoadingSection.classList.remove('hidden');
    },
    onSynced(): void {
      syncAndBind();
    },
    cleanup(): void {
      if (responseHandler && registeredProtocol) {
        registeredProtocol.off('response', responseHandler);
        registeredProtocol = null;
        responseHandler = null;
      }
      poller?.stop();
      poller = null;
      pollLastSeen.clear();
      deviceInfoBinding.cleanup();
      scrollModeBinding.cleanup();
      buttonActionsBinding.cleanup();
      directionBinding.cleanup();
      sensitivityBinding.cleanup();
      backlashBinding.cleanup();
      selfTestBinding.cleanup();
      configLoadingSection.classList.add('hidden');
    },
  };
}
