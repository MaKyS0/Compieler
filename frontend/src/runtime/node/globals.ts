/* eslint-disable @typescript-eslint/no-explicit-any */
// Must be imported first: several npm polyfills (util, readable-stream, ...) read `process` while loading.
import { Buffer } from "buffer";

const g = globalThis as any;
g.global = g;
g.Buffer = Buffer;
if (!g.process) {
  g.process = {
    env: {},
    browser: true,
    version: "v22.0.0-browser",
    versions: { node: "22.0.0" },
    platform: "linux",
    cwd: () => "/work",
    nextTick: (fn: (...a: any[]) => void, ...args: any[]) => queueMicrotask(() => fn(...args)),
    emitWarning: () => undefined,
  };
}
export { Buffer };
