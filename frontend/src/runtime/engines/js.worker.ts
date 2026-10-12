/// <reference lib="webworker" />
/* eslint-disable @typescript-eslint/no-explicit-any */
// JavaScript: runs in V8 (the WebView's engine) inside a Worker with a Node.js-compatible environment:
// CommonJS/ESM modules, process, console, fs (project files), path, util, events, readline, crypto, ...
import "../node/globals";
import { Buffer } from "buffer";
import pathMod from "path-browserify";
import { transform } from "sucrase";
import { installTimers, loop, macrotask } from "../node/loop";
import { createBuiltins } from "../node/modules";
import { createConsole, createProcess, type Host } from "../node/stdio";
import { CWD, VFS } from "../node/vfs";
import type { FileMap, FromWorker, ToWorker } from "../protocol";
import { Outbox } from "../outbox";
import { StdinReader } from "../stdin";

const path = pathMod as any;
const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);
const outbox = new Outbox(post);
const out = (phase: "install" | "run" | "system", stream: "stdout" | "stderr" | "system", data: string) => outbox.write(phase, stream, data);

class ExitSignal {
  constructor(public code: number) {}
}

interface Ctx {
  vfs: VFS;
  process: any;
  builtins: Record<string, any>;
  externals: Map<string, any>;
  pkgType: string;
  cache: Map<string, any>;
  finished: boolean;
  finish: (code: number, reason?: "ok" | "error") => void;
}

function moduleNotFound(id: string, from: string) {
  const e: any = new Error(`Cannot find module '${id}'\nRequire stack:\n- ${from}`);
  e.code = "MODULE_NOT_FOUND";
  e.requireStack = [from];
  return e;
}

function syntaxError(abs: string, code: string, e: any): Error {
  // Chrome gives no position for syntax errors raised by eval; sucrase's parser does.
  let line = 1;
  let col = 0;
  let msg = String(e?.message ?? e);
  try {
    transform(code, { transforms: ["imports"], disableESTransforms: true, filePath: abs });
  } catch (se: any) {
    if (se?.loc) (line = se.loc.line), (col = se.loc.column);
    msg = String(se.message).replace(/\s*\(\d+:\d+\)$/, "");
  }
  const src = code.split("\n")[line - 1] ?? "";
  const err = new SyntaxError(msg);
  err.stack = `${abs}:${line}\n${src}\n${" ".repeat(col)}^\n\nSyntaxError: ${msg}`;
  return err;
}

function isEsm(ctx: Ctx, abs: string, code: string): boolean {
  if (abs.endsWith(".mjs")) return true;
  if (abs.endsWith(".cjs")) return false;
  if (ctx.pkgType === "module") return true;
  return /^\s*(import\s+[\w{*'"]|import\s*\{|export\s+(default|const|let|var|function|class|async|\{|\*))/m.test(code);
}

function resolveFile(ctx: Ctx, request: string, dir: string): string | null {
  const base = path.resolve(dir, request);
  const tries = [base, base + ".js", base + ".json", base + ".cjs", base + ".mjs", base + "/index.js", base + "/index.json"];
  for (const t of tries) if (ctx.vfs.files.has(t)) return t;
  const pkg = ctx.vfs.files.get(base + "/package.json");
  if (pkg) {
    try {
      const main = JSON.parse(new TextDecoder().decode(pkg)).main;
      if (main) return resolveFile(ctx, "./" + main, base);
    } catch {
      /* ignore */
    }
  }
  return null;
}

function makeRequire(ctx: Ctx, fromFile: string) {
  const dir = path.dirname(fromFile);
  const req: any = (id: string) => requireFrom(ctx, id, dir, fromFile);
  req.resolve = (id: string) => {
    const bare = id.replace(/^node:/, "");
    if (bare in ctx.builtins) return bare;
    const f = resolveFile(ctx, id, dir);
    if (!f) throw moduleNotFound(id, fromFile);
    return f;
  };
  req.cache = {};
  req.main = undefined;
  return req;
}

function requireFrom(ctx: Ctx, id: string, dir: string, from: string): any {
  const bare = id.replace(/^node:/, "");
  if (ctx.builtins[bare] !== undefined) return ctx.builtins[bare];
  if (id.startsWith(".") || id.startsWith("/")) {
    const f = resolveFile(ctx, id, dir);
    if (!f) throw moduleNotFound(id, from);
    return loadFile(ctx, f);
  }
  const pkgName = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
  if (ctx.externals.has(id)) return ctx.externals.get(id);
  if (ctx.externals.has(pkgName) && id === pkgName) return ctx.externals.get(pkgName);
  throw moduleNotFound(id, from);
}

function loadFile(ctx: Ctx, abs: string, entry = false): any {
  const cached = ctx.cache.get(abs);
  if (cached) return cached.exports;
  const data = ctx.vfs.files.get(abs)!;
  const text = new TextDecoder().decode(data);
  const module: any = { exports: {}, id: abs, filename: abs, loaded: false, children: [], paths: [] };
  ctx.cache.set(abs, module);
  if (abs.endsWith(".json")) {
    try {
      module.exports = JSON.parse(text);
    } catch (e: any) {
      e.message = `${abs}: ${e.message}`;
      throw e;
    }
    return module.exports;
  }
  let code = text;
  if (isEsm(ctx, abs, text)) {
    try {
      code = transform(text, { transforms: ["imports"], disableESTransforms: true, filePath: abs }).code;
    } catch (e) {
      throw syntaxError(abs, text, e);
    }
  }
  const req = makeRequire(ctx, abs);
  if (entry) req.main = module;
  const run = (asyncWrap: boolean) => {
    const wrapped = `(${asyncWrap ? "async " : ""}function (exports, require, module, __filename, __dirname) {${code}\n})\n//# sourceURL=${abs}`;
    const fn = (0, eval)(wrapped);
    return fn.call(module.exports, module.exports, req, module, abs, path.dirname(abs));
  };
  try {
    run(false);
  } catch (e: any) {
    if (e instanceof SyntaxError) {
      if (/await/.test(e.message) && isEsm(ctx, abs, text)) {
        const p = run(true); // top-level await: run the module body as an async function
        module.promise = p;
      } else throw syntaxError(abs, text, e);
    } else throw e;
  }
  module.loaded = true;
  return module.exports;
}

const BUILTIN_NAMES = new Set(["assert", "buffer", "crypto", "events", "fs", "os", "path", "readline", "stream", "string_decoder", "timers", "url", "util", "process", "child_process", "http", "https", "net", "zlib", "worker_threads", "module", "perf_hooks", "querystring", "constants", "vm", "v8", "dns", "tls", "dgram", "cluster", "http2", "async_hooks", "inspector", "punycode"]);

function bareSpecifiers(files: FileMap): string[] {
  const set = new Set<string>();
  const dec = new TextDecoder();
  for (const [p, d] of Object.entries(files)) {
    if (!/\.(m?js|cjs)$/.test(p)) {
      if (p === "package.json") {
        try {
          const j = JSON.parse(dec.decode(d));
          for (const k of Object.keys({ ...j.dependencies, ...j.devDependencies })) set.add(k);
        } catch {
          /* ignore */
        }
      }
      continue;
    }
    const code = dec.decode(d);
    for (const m of code.matchAll(/(?:require\s*\(\s*|from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
      const id = m[1];
      if (id.startsWith(".") || id.startsWith("/") || id.startsWith("node:")) continue;
      const name = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
      const root = name.split("/")[0];
      if (BUILTIN_NAMES.has(root) || BUILTIN_NAMES.has(name)) continue;
      set.add(id);
    }
  }
  return [...set];
}

/** Best effort: fetch pure-JS npm packages from a CDN (needs internet). Offline, `require` reports the missing module. */
async function prefetchExternals(specs: string[], externals: Map<string, any>) {
  if (!specs.length) return;
  out("install", "stdout", `Fetching ${specs.join(", ")} ...\n`);
  await Promise.all(
    specs.map(async (spec) => {
      try {
        const ns: any = await import(/* @vite-ignore */ `https://esm.sh/${spec}?bundle&target=es2022`);
        const keys = Object.keys(ns).filter((k) => k !== "default" && k !== "__esModule");
        const value = "default" in ns && (keys.length === 0 || typeof ns.default === "function") ? Object.assign(ns.default, keys.length ? Object.fromEntries(keys.map((k) => [k, ns[k]])) : {}) : { ...ns };
        externals.set(spec, value);
      } catch (e) {
        out("install", "stderr", `could not load '${spec}': ${String((e as Error).message ?? e).split("\n")[0]}\n`);
      }
    }),
  );
}

function formatUncaught(ctx: Ctx, err: any): string {
  const stack: string = err && err.stack ? String(err.stack) : `Uncaught ${String(err)}`;
  // already formatted by syntaxError()
  if (/^\/work\/.*:\d+\n/.test(stack)) return `${stack}\n\nNode.js ${ctx.process.version}\n`;
  const m = /\((\/work\/[^():]+):(\d+):(\d+)\)|at (\/work\/[^():]+):(\d+):(\d+)/.exec(stack);
  let head = "";
  if (m) {
    const file = m[1] ?? m[4];
    const line = +(m[2] ?? m[5]);
    const col = +(m[3] ?? m[6]);
    const src = ctx.vfs.files.get(file);
    const text = src ? (new TextDecoder().decode(src).split("\n")[line - 1] ?? "") : "";
    head = `${file}:${line}\n${text}\n${" ".repeat(Math.max(0, col - 1))}^\n\n`;
  }
  const cleaned = stack.split("\n").filter((l) => !/^\s+at .*(js\.worker|eval at|<anonymous>|node_modules|assets\/)/.test(l) || /\/work\//.test(l)).join("\n");
  const body = err && err.stack ? cleaned : `Uncaught ${util_inspect(err)}`;
  return `${head}${body}\n\nNode.js ${ctx.process.version}\n`;
}
let util_inspect: (v: any) => string = String;

async function run(msg: Extract<ToWorker, { type: "run" }>) {
  const t0 = performance.now();
  const reader = new StdinReader(msg.stdin.sab, msg.stdin.prefill, msg.stdin.closed, () => (outbox.flush(), post({ type: "need-input" })), msg.stdin.native ?? null);
  (globalThis as any).__stdinRead = (n: number) => reader.read(n);
  const vfs = new VFS(msg.files, { readAll: () => reader.readAll() });
  const dec = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  void dec;
  const host: Host = { write: (stream, text) => out("run", stream, text), reader };

  let ctx!: Ctx;
  const finish = (code: number, reason?: "ok" | "error") => {
    if (ctx.finished) return;
    ctx.finished = true;
    try {
      ctx.process.emit("exit", code);
    } catch {
      /* ignore */
    }
    const { changed, deleted } = vfs.diff();
    outbox.flush();
    post({ type: "done", code, reason: reason ?? (code === 0 ? "ok" : "error"), changed, deleted, durationMs: Math.round(performance.now() - t0) });
  };
  const exit = (code: number): never => {
    finish(code);
    throw new ExitSignal(code);
  };

  const entryAbs = `${CWD}/${msg.entry}`;
  const proc = createProcess(host, ["node", entryAbs, ...msg.args], exit, msg.env);
  const g = globalThis as any;
  g.process = proc;
  g.console = createConsole(host);
  installTimers(g);
  g.require = undefined;
  g.module = undefined;
  const builtins = createBuiltins(vfs.moduleObject());
  builtins.process = proc;
  util_inspect = (v) => (builtins.util as any).inspect(v);
  let pkgType = "commonjs";
  try {
    const pj = msg.files["package.json"];
    if (pj) pkgType = JSON.parse(new TextDecoder().decode(pj)).type ?? "commonjs";
  } catch {
    /* invalid package.json is reported by the run itself */
  }
  ctx = { vfs, process: proc, builtins, externals: new Map(), pkgType, cache: new Map(), finished: false, finish };

  const fatal = (err: any) => {
    if (err instanceof ExitSignal) return;
    host.write("stderr", formatUncaught(ctx, err));
    finish(1);
  };
  self.addEventListener("error", (e: ErrorEvent) => (e.preventDefault(), fatal(e.error ?? new Error(e.message))));
  self.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => (e.preventDefault(), fatal(e.reason)));

  if (!vfs.files.has(entryAbs)) {
    out("system", "stderr", `Entry file '${msg.entry}' does not exist.\n`);
    return finish(1);
  }
  outbox.flush();
  post({ type: "phase", phase: "install" });
  await prefetchExternals(bareSpecifiers(msg.files), ctx.externals);
  outbox.flush();
  post({ type: "phase", phase: "run" });

  let mainModule: any;
  try {
    loadFile(ctx, entryAbs, true);
    mainModule = ctx.cache.get(entryAbs);
    if (mainModule?.promise) await mainModule.promise;
  } catch (e) {
    fatal(e);
  }
  // keep running until nothing is left to do (timers, open stdin reader, ...)
  while (!ctx.finished) {
    await macrotask();
    if (loop.handles > 0) continue;
    await macrotask();
    if (loop.handles > 0) continue;
    try {
      proc.emit("beforeExit", proc.exitCode ?? 0);
    } catch (e) {
      fatal(e);
    }
    await macrotask();
    if (loop.handles > 0) continue;
    finish(Number(proc.exitCode ?? 0) | 0);
  }
  void Buffer;
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === "init") return post({ type: "ready" });
  if (msg.type === "install") {
    out("system", "stderr", "npm packages are fetched automatically from a CDN when the program requires them (internet needed).\n");
    return post({ type: "done", code: 0, reason: "ok", changed: {}, deleted: [], durationMs: 0 });
  }
  try {
    await run(msg);
  } catch (e) {
    if (e instanceof ExitSignal) return;
    out("system", "stderr", `JavaScript engine failed: ${String((e as Error).stack ?? e)}\n`);
    post({ type: "done", code: null, reason: "error", changed: {}, deleted: [], durationMs: 0, detail: "engine" });
  }
};
