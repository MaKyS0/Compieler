/* eslint-disable @typescript-eslint/no-explicit-any */
import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { util } from "./nodeUtil";
import type { StdinReader } from "../stdin";
import { loop } from "./loop";

export interface Host {
  write(stream: "stdout" | "stderr", text: string): void;
  reader: StdinReader;
}

const dec = new TextDecoder();
const asText = (d: any) => (typeof d === "string" ? d : dec.decode(d instanceof Uint8Array ? d : Buffer.from(d)));

/** process.stdin: a pull-based Readable on top of the blocking reader, scheduled from timers. */
export class Stdin extends EventEmitter {
  fd = 0;
  isTTY = false;
  readable = true;
  private encoding: string | null = null;
  private flowing = false;
  private ended = false;
  private holding = false;
  private scheduled = false;
  private buffer: Buffer | null = null;

  constructor(private reader: StdinReader) {
    super();
  }
  setEncoding(e: string) {
    this.encoding = e;
    return this;
  }
  private hold(on: boolean) {
    if (on && !this.holding) (this.holding = true), loop.handles++;
    else if (!on && this.holding) (this.holding = false), loop.handles--;
  }
  private schedule() {
    if (this.scheduled || !this.flowing || this.ended) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.pump();
    }, 0).unref?.();
  }
  private pump() {
    if (!this.flowing || this.ended) return;
    const chunk = this.reader.read(65536);
    if (!chunk.length) return this.finish();
    const buf = Buffer.from(chunk);
    if (this.listenerCount("readable")) {
      this.buffer = this.buffer ? Buffer.concat([this.buffer, buf]) : buf;
      this.emit("readable");
    } else this.emit("data", this.encoding ? buf.toString(this.encoding as any) : buf);
    this.schedule();
  }
  private finish() {
    this.ended = true;
    this.readable = false;
    this.hold(false);
    if (this.listenerCount("readable")) this.emit("readable");
    this.emit("end");
    this.emit("close");
  }
  read() {
    const b = this.buffer;
    this.buffer = null;
    if (!b) return null;
    return this.encoding ? b.toString(this.encoding as any) : b;
  }
  resume() {
    if (this.ended) return this;
    this.flowing = true;
    this.hold(true);
    this.schedule();
    return this;
  }
  pause() {
    this.flowing = false;
    this.hold(false);
    return this;
  }
  unref() {
    this.hold(false);
    return this;
  }
  ref() {
    if (this.flowing) this.hold(true);
    return this;
  }
  on(ev: string | symbol, fn: (...a: any[]) => void) {
    super.on(ev, fn);
    if (ev === "data" || ev === "readable") this.resume();
    return this;
  }
  addListener = this.on;
  pipe(dest: any) {
    this.on("data", (d: any) => dest.write(d));
    return dest;
  }
  destroy() {
    this.pause();
    this.ended = true;
  }
  async *[Symbol.asyncIterator]() {
    this.resume();
    this.pause(); // we pull manually below, but keep the handle while iterating
    this.hold(true);
    try {
      for (;;) {
        const chunk = await new Promise<Uint8Array>((res) => setTimeout(() => res(this.reader.read(65536)), 0));
        if (!chunk.length) return;
        const buf = Buffer.from(chunk);
        yield this.encoding ? buf.toString(this.encoding as any) : buf;
      }
    } finally {
      this.hold(false);
    }
  }
}

function makeWritable(host: Host, stream: "stdout" | "stderr") {
  const w: any = new EventEmitter();
  w.fd = stream === "stdout" ? 1 : 2;
  w.isTTY = false;
  w.writable = true;
  w.write = (data: any, enc?: any, cb?: any) => {
    host.write(stream, asText(data));
    const done = typeof enc === "function" ? enc : cb;
    if (done) setTimeout(done, 0);
    return true;
  };
  w.end = (data?: any) => {
    if (data) w.write(data);
  };
  w.cork = w.uncork = () => undefined;
  w.getWindowSize = () => [80, 24];
  w.columns = 80;
  return w;
}

export function createProcess(host: Host, argv: string[], exit: (code: number) => never, env: Record<string, string> = {}): any {
  const proc: any = new EventEmitter();
  proc.argv = argv;
  proc.argv0 = "node";
  proc.execPath = "/usr/bin/node";
  proc.execArgv = [];
  proc.env = { LANG: "C.UTF-8", HOME: "/home", PATH: "/usr/bin", ...env };
  proc.platform = "linux";
  proc.arch = "x64";
  proc.pid = 1;
  proc.ppid = 0;
  proc.title = "node";
  proc.version = "v22.0.0-browser";
  proc.versions = { node: "22.0.0", v8: "browser", modules: "127" };
  proc.release = { name: "node" };
  proc.exitCode = undefined;
  proc.cwd = () => "/work";
  proc.chdir = () => undefined;
  proc.umask = () => 0o22;
  proc.uptime = () => performance.now() / 1000;
  proc.hrtime = Object.assign(
    (prev?: [number, number]) => {
      const t = performance.now();
      const s = Math.floor(t / 1000);
      const ns = Math.floor((t % 1000) * 1e6);
      return prev ? [s - prev[0] - (ns < prev[1] ? 1 : 0), (ns - prev[1] + 1e9) % 1e9] : [s, ns];
    },
    { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
  );
  proc.memoryUsage = Object.assign(() => ({ rss: 5e7, heapTotal: 3e7, heapUsed: 2e7, external: 1e6, arrayBuffers: 1e5 }), { rss: () => 5e7 });
  proc.cpuUsage = () => ({ user: 0, system: 0 });
  proc.nextTick = (fn: (...a: any[]) => void, ...args: any[]) => queueMicrotask(() => fn(...args));
  proc.emitWarning = (w: any) => host.write("stderr", `(node) Warning: ${w?.message ?? w}\n`);
  proc.exit = (code?: number) => exit(code ?? proc.exitCode ?? 0);
  proc.abort = () => exit(134);
  proc.kill = () => true;
  proc.stdout = makeWritable(host, "stdout");
  proc.stderr = makeWritable(host, "stderr");
  proc.stdin = new Stdin(host.reader);
  proc.binding = () => {
    throw new Error("process.binding is not supported");
  };
  return proc;
}

export function createConsole(host: Host) {
  let indent = "";
  const counts = new Map<string, number>();
  const timers = new Map<string, number>();
  const line = (stream: "stdout" | "stderr", args: any[]) => {
    const text = util.format(...args);
    host.write(stream, (indent ? text.split("\n").map((l: string) => indent + l).join("\n") : text) + "\n");
  };
  const c: any = {
    log: (...a: any[]) => line("stdout", a),
    info: (...a: any[]) => line("stdout", a),
    debug: (...a: any[]) => line("stdout", a),
    error: (...a: any[]) => line("stderr", a),
    warn: (...a: any[]) => line("stderr", a),
    trace: (...a: any[]) => line("stderr", ["Trace:", ...a, "\n" + new Error().stack?.split("\n").slice(2).join("\n")]),
    dir: (o: any, opts?: any) => line("stdout", [util.inspect(o, { customInspect: false, ...opts })]),
    assert: (cond: any, ...a: any[]) => cond || line("stderr", ["Assertion failed" + (a.length ? ":" : ""), ...a]),
    group: (...a: any[]) => {
      if (a.length) line("stdout", a);
      indent += "  ";
    },
    groupEnd: () => void (indent = indent.slice(2)),
    count: (l = "default") => line("stdout", [`${l}: ${(counts.set(l, (counts.get(l) ?? 0) + 1), counts.get(l))}`]),
    countReset: (l = "default") => void counts.delete(l),
    time: (l = "default") => void timers.set(l, performance.now()),
    timeEnd: (l = "default") => {
      line("stdout", [`${l}: ${(performance.now() - (timers.get(l) ?? performance.now())).toFixed(3)}ms`]);
      timers.delete(l);
    },
    timeLog: (l = "default", ...a: any[]) => line("stdout", [`${l}: ${(performance.now() - (timers.get(l) ?? performance.now())).toFixed(3)}ms`, ...a]),
    table: (data: any) => {
      if (!data || typeof data !== "object") return line("stdout", [data]);
      const rows = Array.isArray(data) ? data.map((v, i) => [String(i), v]) : Object.entries(data);
      const cols = new Set<string>();
      let hasValues = false;
      for (const [, v] of rows) v && typeof v === "object" ? Object.keys(v).forEach((k) => cols.add(k)) : (hasValues = true);
      const head = ["(index)", ...cols, ...(hasValues ? ["Values"] : [])];
      const body = rows.map(([k, v]: any) => [k, ...[...cols].map((c) => (v && typeof v === "object" && c in v ? util.inspect(v[c]) : "")), ...(hasValues ? [v && typeof v === "object" ? "" : util.inspect(v)] : [])]);
      const widths = head.map((h, i) => Math.max(h.length, ...body.map((r: string[]) => r[i].length)) + 2);
      const fmt = (r: string[]) => "│" + r.map((cell, i) => cell.padStart(Math.floor((widths[i] + cell.length) / 2)).padEnd(widths[i])).join("│") + "│";
      const bar = (l: string, m: string, r: string) => l + widths.map((w) => "─".repeat(w)).join(m) + r;
      line("stdout", [[bar("┌", "┬", "┐"), fmt(head), bar("├", "┼", "┤"), ...body.map(fmt), bar("└", "┴", "┘")].join("\n")]);
    },
  };
  c.dirxml = c.log;
  c.groupCollapsed = c.group;
  return c;
}

/** readline: line splitting over an input stream, question(), prompt(), async iteration. */
export function createReadline(promises: boolean) {
  class Interface extends EventEmitter {
    closed = false;
    line = "";
    terminal = false;
    private partial = "";
    private questions: Array<(a: string) => void> = [];
    private queue: string[] = [];
    private waiters: Array<(r: IteratorResult<string>) => void> = [];
    private promptStr = "> ";
    private onData = (d: any) => this.feed(typeof d === "string" ? d : Buffer.from(d).toString("utf8"));
    private onEnd = () => {
      if (this.partial) this.emitLine(this.partial);
      this.partial = "";
      this.close();
    };

    constructor(
      private input: any,
      private output?: any,
    ) {
      super();
      input.on?.("data", this.onData);
      input.on?.("end", this.onEnd);
    }
    private feed(chunk: string) {
      this.partial += chunk;
      const parts = this.partial.split(/\r\n|\n|\r/);
      this.partial = parts.pop() ?? "";
      for (const l of parts) {
        if (this.closed) return;
        this.emitLine(l);
      }
    }
    private emitLine(l: string) {
      const q = this.questions.shift();
      if (q) return q(l);
      if (this.waiters.length) this.waiters.shift()!({ value: l, done: false });
      else if (this.listenerCount("line") === 0 && this.hasIterator) this.queue.push(l);
      this.emit("line", l);
    }
    private hasIterator = false;
    setPrompt(p: string) {
      this.promptStr = p;
    }
    getPrompt() {
      return this.promptStr;
    }
    prompt() {
      this.output?.write(this.promptStr);
    }
    question(query: string, a?: any, b?: any): any {
      const cb = typeof a === "function" ? a : b;
      if (promises && !cb)
        return new Promise<string>((res) => {
          this.output?.write(query);
          this.questions.push(res);
        });
      this.output?.write(query);
      this.questions.push(cb ?? (() => undefined));
    }
    write(d: any) {
      if (typeof d === "string") this.feed(d);
    }
    pause() {
      this.input.pause?.();
      return this;
    }
    resume() {
      this.input.resume?.();
      return this;
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.input.off?.("data", this.onData);
      this.input.off?.("end", this.onEnd);
      this.input.pause?.();
      for (const w of this.waiters.splice(0)) w({ value: undefined as any, done: true });
      this.emit("close");
    }
    [Symbol.asyncIterator]() {
      this.hasIterator = true;
      this.input.resume?.();
      return {
        next: (): Promise<IteratorResult<string>> => {
          if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
          if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
          return new Promise((res) => this.waiters.push(res));
        },
        return: async () => (this.close(), { value: undefined as any, done: true as const }),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    }
  }
  return {
    Interface,
    createInterface: (opts: any, output?: any) => {
      const o = opts && typeof opts.on === "function" ? { input: opts, output } : opts;
      const rl = new Interface(o.input, o.output);
      if (o.prompt !== undefined) rl.setPrompt(o.prompt);
      return rl;
    },
    clearLine: () => true,
    cursorTo: () => true,
    moveCursor: () => true,
    emitKeypressEvents: () => undefined,
  };
}
