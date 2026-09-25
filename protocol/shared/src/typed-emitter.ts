// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => void;

export class TypedEmitter<Events extends Record<string, unknown[]>> {
  private readonly _listeners = new Map<keyof Events, Set<AnyFn>>();

  on<K extends keyof Events>(
    event: K,
    listener: (...args: Events[K]) => void
  ): void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(listener);
  }

  off<K extends keyof Events>(
    event: K,
    listener: (...args: Events[K]) => void
  ): void {
    this._listeners.get(event)?.delete(listener);
  }

  protected emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const listeners = this._listeners.get(event);
    if (!listeners) return;
    for (const l of [...listeners]) l(...args);
  }
}
