export const STATUS_AUTO_CLEAR_MS = 2000;

export type StatusState = 'success' | 'error' | 'loading';

const STATUS_CLASS: Record<StatusState, string> = {
  success: 'status-indicator status-success',
  error: 'status-indicator status-error',
  loading: 'status-indicator status-loading',
};

const statusClearTimers = new WeakMap<
  HTMLSpanElement,
  ReturnType<typeof setTimeout>
>();

export function setFieldStatus(
  dot: HTMLSpanElement,
  text: HTMLSpanElement,
  state: StatusState,
  label: string,
  autoClear = false
): void {
  const pending = statusClearTimers.get(dot);
  if (pending !== undefined) clearTimeout(pending);

  dot.className = STATUS_CLASS[state];
  text.textContent = label;

  if (autoClear) {
    const timer = setTimeout(() => {
      dot.className = 'status-indicator status-idle';
      text.textContent = '';
      statusClearTimers.delete(dot);
    }, STATUS_AUTO_CLEAR_MS);
    statusClearTimers.set(dot, timer);
  }
}
