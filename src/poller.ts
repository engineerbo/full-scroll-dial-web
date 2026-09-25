export class Poller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private _pendingCommands = 0;

  constructor(
    private readonly sendGas: () => void,
    private readonly intervalMs: number = 1000
  ) {}

  start(signal?: AbortSignal): void {
    this.stop();
    this._pendingCommands = 0;
    this.poll();
    this.timer = setInterval(() => {
      this.poll();
    }, this.intervalMs);
    signal?.addEventListener('abort', () => this.stop(), { once: true });
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  beginCommand(): void {
    this._pendingCommands++;
  }

  endCommand(): void {
    this._pendingCommands--;
  }

  private poll(): void {
    if (this._pendingCommands > 0) return;
    this.sendGas();
  }
}
