type Overlay = 'slideRing' | 'buttonRing' | 'led';

interface DfuStep {
  num: number;
  label: string;
  animClass: string;
  contentZ10: boolean;
  overlay: Overlay;
  slideVariant: 'on' | 'off';
  bottomAlt: string;
  usbClass: string;
}

const STEPS: DfuStep[] = [
  {
    num: 1,
    label: '1 · Power off',
    animClass: 'animate-dfu-step-1',
    contentZ10: false,
    overlay: 'slideRing',
    slideVariant: 'on',
    bottomAlt: 'Device bottom (powered off)',
    usbClass: 'h-auto w-7 -mt-3.5 translate-y-6',
  },
  {
    num: 2,
    label: '2 · Hold button',
    animClass: 'animate-dfu-step-2',
    contentZ10: false,
    overlay: 'buttonRing',
    slideVariant: 'off',
    bottomAlt: 'Device bottom (hold button)',
    usbClass: 'h-auto w-7 -mt-3.5 translate-y-6',
  },
  {
    num: 3,
    label: '3 · Plug in USB-C',
    animClass: 'animate-dfu-step-3',
    contentZ10: true,
    overlay: 'buttonRing',
    slideVariant: 'off',
    bottomAlt: 'Device bottom (hold button + plug USB)',
    usbClass: 'h-auto w-7 -mt-3.5 animate-usb-plug-dfu',
  },
  {
    num: 4,
    label: '4 · Blue LED → Bootloader mode',
    animClass: 'animate-dfu-step-4',
    contentZ10: true,
    overlay: 'led',
    slideVariant: 'off',
    bottomAlt: 'Device bottom (bootloader mode)',
    usbClass: 'h-auto w-7 -mt-3.5',
  },
];

function overlayHtml(overlay: Overlay): string {
  switch (overlay) {
    case 'slideRing':
      return `<div class="absolute z-20 animate-slide-ring-show" style="left: 50%; top: 91.5%">
          <div class="absolute rounded-full bg-green-400/50 animate-ping" style="width: 36px; height: 21px; left: -18px; top: -10.5px"></div>
          <div class="absolute rounded-full border-2 border-green-400/70" style="width: 36px; height: 21px; left: -18px; top: -10.5px"></div>
        </div>`;
    case 'buttonRing':
      return `<div class="absolute z-20" style="left: var(--dfu-button-left); top: var(--dfu-button-top)">
          <div class="absolute h-7 w-7 rounded-full bg-green-400 animate-ping opacity-50" style="left: -0.875rem; top: -0.875rem"></div>
          <div class="absolute h-5 w-5 rounded-full border-2 border-green-500 bg-green-200/40 dark:bg-green-400/30" style="left: -0.625rem; top: -0.625rem"></div>
        </div>`;
    case 'led':
      return `<div class="absolute z-20" style="left: var(--dfu-led-left); top: var(--dfu-led-top)">
          <div class="absolute rounded-full bg-green-400/50 animate-ping" style="width: 36px; height: 16px; left: -18px; top: -8px"></div>
          <div class="absolute rounded-full border-2 border-green-400/70" style="width: 36px; height: 16px; left: -18px; top: -8px"></div>
          <div class="absolute rounded-full animate-ping led-halo"></div>
          <div class="absolute rounded-full led-core"></div>
        </div>`;
  }
}

function stepHtml(step: DfuStep): string {
  const z = step.contentZ10 ? ' z-10' : '';
  return `<div class="${step.animClass} absolute inset-x-0 top-0 flex flex-col items-center">
          <div class="relative w-40 h-40${z}">
            <div class="absolute inset-0" style="transform: rotate(var(--dfu-device-rotation))">
              ${overlayHtml(step.overlay)}
              <svg class="absolute z-0" style="width: 25%; top: var(--dfu-slide-top); left: 50%; transform: translateX(-50%)" viewBox="0 0 113 53" xmlns="http://www.w3.org/2000/svg">
                <use href="#slide-${step.slideVariant}" />
              </svg>
              <img src="/src/assets/bottom.svg" class="absolute inset-0 z-10 w-40 h-40" alt="${step.bottomAlt}" />
            </div>
            <span aria-label="Step ${step.num} of 4" class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 rounded-full bg-neutral-800/65 px-2 py-0.5 text-[10px] font-medium text-white whitespace-nowrap dark:bg-black/50">
              ${step.label}
            </span>
          </div>
          <img src="/src/assets/usb.svg" class="${step.usbClass}" alt="USB-C cable" />
        </div>`;
}

export function renderDfuSteps(container: HTMLElement): void {
  container.innerHTML = `<div class="relative flex justify-center overflow-hidden">
        <div class="invisible pointer-events-none flex flex-col items-center" aria-hidden="true">
          <div class="h-40"></div>
          <img src="/src/assets/usb.svg" class="h-auto w-7 -mt-3.5" alt="" />
        </div>
        ${STEPS.map(stepHtml).join('\n        ')}
      </div>
      <div class="mt-2 -mb-3.5 flex justify-center gap-1.5" aria-hidden="true">
        <span class="block w-1.5 h-1.5 rounded-full bg-neutral-500 dark:bg-neutral-400 animate-dfu-dot-1"></span>
        <span class="block w-1.5 h-1.5 rounded-full bg-neutral-500 dark:bg-neutral-400 animate-dfu-dot-2"></span>
        <span class="block w-1.5 h-1.5 rounded-full bg-neutral-500 dark:bg-neutral-400 animate-dfu-dot-3"></span>
        <span class="block w-1.5 h-1.5 rounded-full bg-neutral-500 dark:bg-neutral-400 animate-dfu-dot-4"></span>
      </div>`;
}
