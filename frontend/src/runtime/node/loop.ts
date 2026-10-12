/* eslint-disable @typescript-eslint/no-explicit-any */
// Event-loop bookkeeping: Node exits when nothing keeps the loop alive. Workers never exit on their own,
// so timers and readers register "handles" here and the runner exits when the count drops to zero.
export const loop = { handles: 0 };

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeClearInterval = globalThis.clearInterval.bind(globalThis);
export const macrotask = () => new Promise<void>((r) => nativeSetTimeout(r, 0));

class Timer {
  refed = true;
  constructor(
    public id: any,
    public interval: boolean,
  ) {}
  ref() {
    if (!this.refed) (this.refed = true), loop.handles++;
    return this;
  }
  unref() {
    if (this.refed) (this.refed = false), loop.handles--;
    return this;
  }
  hasRef() {
    return this.refed;
  }
  refresh() {
    return this;
  }
  close() {
    release(this);
    return this;
  }
  [Symbol.toPrimitive]() {
    return Number(this.id);
  }
}
const live = new WeakSet<Timer>();
const byId = new Map<any, Timer>();
function release(t: Timer) {
  if (!live.has(t)) return;
  live.delete(t);
  byId.delete(+t.id);
  if (t.refed) loop.handles--;
  (t.interval ? nativeClearInterval : nativeClearTimeout)(t.id);
}

export function installTimers(g: any) {
  g.setTimeout = (fn: (...a: any[]) => void, ms?: number, ...args: any[]) => {
    const t: Timer = new Timer(0, false);
    loop.handles++;
    live.add(t);
    t.id = nativeSetTimeout(() => {
      if (!live.has(t)) return;
      live.delete(t);
      byId.delete(+t.id);
      if (t.refed) loop.handles--;
      fn(...args);
    }, ms);
    byId.set(+t.id, t);
    return t;
  };
  g.setInterval = (fn: (...a: any[]) => void, ms?: number, ...args: any[]) => {
    const t: Timer = new Timer(0, true);
    loop.handles++;
    live.add(t);
    t.id = nativeSetInterval(() => fn(...args), ms);
    byId.set(+t.id, t);
    return t;
  };
  g.setImmediate = (fn: (...a: any[]) => void, ...args: any[]) => g.setTimeout(fn, 0, ...args);
  const clear = (t: any) => {
    const timer = t instanceof Timer ? t : byId.get(+t);
    if (timer) release(timer);
  };
  g.clearTimeout = clear;
  g.clearInterval = clear;
  g.clearImmediate = clear;
}

/** Keep the loop alive while a promise-based operation (fetch, ...) is pending. */
export function track<T>(p: Promise<T>): Promise<T> {
  loop.handles++;
  return p.finally(() => loop.handles--);
}
