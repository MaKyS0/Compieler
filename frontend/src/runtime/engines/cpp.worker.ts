/// <reference lib="webworker" />
// C++: LLVM/Clang + lld (YoWASP build, compiled to WebAssembly) with a wasi-libc / libc++ sysroot.
// Programs are compiled to wasm32-wasi (no C++ exceptions) and executed inside this worker with a small
// WASI implementation: blocking stdin from the host, unbuffered output, an in-memory file system.
import type { FileMap, FromWorker, ToWorker } from "../protocol";
import { Outbox } from "../outbox";
import { StdinReader } from "../stdin";
import { WasiRuntime, ProcExit } from "./wasi";

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);
type Phase = "compile" | "run" | "system";
const outbox = new Outbox(post);
const out = (phase: Phase, stream: "stdout" | "stderr" | "system", data: string) => outbox.write(phase, stream, data);

// stdout unbuffered: a printf prompt must be visible before scanf blocks (wasi-libc buffers stdout when it is not a tty)
const HOOK = `#include <cstdio>\n__attribute__((constructor)) static void compieler_unbuffer() { std::setvbuf(stdout, nullptr, _IONBF, 0); }\n`;

type Tree = { [name: string]: Tree | string | Uint8Array };
type RunClang = (args: string[], files?: Tree, options?: Record<string, unknown>) => Promise<Tree>;
let runClang: RunClang | null = null;
let loading: Promise<RunClang> | null = null;

const quiet = () => undefined;

// --- optional remote engine ----------------------------------------------------------------------------
// The Android app ships without the ~100 MB compiler: engines/cpp/remote.json names a CDN folder instead. The
// files are downloaded on first use and kept in the Cache Storage, so later runs work offline.
interface RemoteConfig {
  base: string;
  version: string;
  files: string[];
  approxMB: number;
}
let remoteCfg: RemoteConfig | null | undefined;
let onProgress: ((doneMB: number, totalMB: number) => void) | null = null;
let fetchInstalled = false;

const localUrl = (base: string, name: string) => new URL(`${base}cpp/${name}`, self.location.href).href;

async function remoteConfig(base: string): Promise<RemoteConfig | null> {
  if (remoteCfg !== undefined) return remoteCfg;
  try {
    const res = await fetch(localUrl(base, "remote.json"));
    remoteCfg = res.ok ? ((await res.json()) as RemoteConfig) : null;
  } catch {
    remoteCfg = null; // missing file (or a server answering with an HTML fallback page): the compiler is bundled
  }
  return remoteCfg;
}

const cacheName = (cfg: RemoteConfig) => `compieler-cpp-${cfg.version}`;

async function remoteCached(cfg: RemoteConfig, base: string): Promise<boolean> {
  try {
    const cache = await caches.open(cacheName(cfg));
    for (const f of cfg.files) if (!(await cache.match(localUrl(base, f)))) return false;
    return true;
  } catch {
    return false;
  }
}

function installRemoteFetch(cfg: RemoteConfig, base: string) {
  if (fetchInstalled) return;
  fetchInstalled = true;
  const original = self.fetch.bind(self);
  const prefix = localUrl(base, "");
  const totalBytes = cfg.approxMB * 1024 * 1024;
  let loaded = 0;
  self.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const name = url.startsWith(prefix) ? url.slice(prefix.length).split("?")[0] : "";
    if (!cfg.files.includes(name)) return original(input, init);
    const cache = await caches.open(cacheName(cfg)).catch(() => null);
    const hit = await cache?.match(url);
    if (hit) return hit;
    const res = await original(cfg.base + name);
    if (!res.ok || !res.body) throw new Error(`${name}: HTTP ${res.status}`);
    const headers = { "content-type": name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" };
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          loaded += chunk.length;
          onProgress?.(loaded / 1048576, totalBytes / 1048576);
          ctl.enqueue(chunk);
        },
      }),
    );
    if (!cache) return new Response(counted, { headers });
    const [toCache, toCaller] = counted.tee();
    void cache.put(url, new Response(toCache, { headers })).catch(() => undefined); // quota problems: just download again next time
    return new Response(toCaller, { headers });
  };
}

async function load(base: string): Promise<RunClang> {
  if (runClang) return runClang;
  if (!loading) {
    loading = (async () => {
      const cfg = await remoteConfig(base);
      if (cfg) installRemoteFetch(cfg, base);
      const mod = (await import(/* @vite-ignore */ localUrl(base, "bundle.js"))) as { runClang: RunClang };
      // warm-up: fetches and compiles the toolchain (~100 MB of WebAssembly) once
      await mod.runClang(["clang++", "--version"], {}, { stdout: quiet, stderr: quiet, fetchProgress: quiet });
      runClang = mod.runClang;
      return runClang;
    })().catch((e) => {
      loading = null; // allow a retry (e.g. after the connection came back)
      throw e;
    });
  }
  return loading;
}

const SOURCE = /\.(cpp|cc|cxx|c\+\+)$/i;
const enc = new TextEncoder();

function pickSources(files: FileMap, entry: string): string[] {
  const all = Object.keys(files).filter((p) => SOURCE.test(p));
  const dec = new TextDecoder();
  const mains = all.filter((p) => /\bmain\s*\(/.test(dec.decode(files[p])));
  let chosen = all;
  if (mains.length > 1) {
    chosen = all.filter((p) => !mains.includes(p) || p === entry);
    if (!chosen.includes(entry)) chosen.push(entry);
  }
  return chosen.sort();
}

function setPath(tree: Tree, path: string, data: Uint8Array) {
  const parts = path.split("/");
  let dir = tree;
  for (const part of parts.slice(0, -1)) dir = (dir[part] ??= {}) as Tree;
  dir[parts[parts.length - 1]] = data;
}

async function run(msg: Extract<ToWorker, { type: "run" }>) {
  const t0 = performance.now();
  const reader = new StdinReader(msg.stdin.sab, msg.stdin.prefill, msg.stdin.closed, () => (outbox.flush(), post({ type: "need-input" })), msg.stdin.native ?? null);
  const decoders = new Map<string, TextDecoder>();
  const emit = (ph: Phase, fd: number, bytes: Uint8Array | null) => {
    if (!bytes || !bytes.length) return;
    const key = `${ph}${fd}`;
    let d = decoders.get(key);
    if (!d) decoders.set(key, (d = new TextDecoder()));
    out(ph, fd === 2 ? "stderr" : "stdout", d.decode(bytes, { stream: true }));
  };
  const done = (code: number | null, reason: "ok" | "error" | "compile_error", detail?: string) =>
    (outbox.flush(),
    post({ type: "done", code, reason, changed: {}, deleted: [], durationMs: Math.round(performance.now() - t0), detail }));

  const sources = pickSources(msg.files, msg.entry);
  if (!sources.length) {
    out("system", "stderr", "No C++ source files (.cpp, .cc, .cxx) found in the project.\n");
    return done(null, "compile_error");
  }
  const std = msg.std ?? "c++23";
  const opt = msg.opt ?? "-O2";
  outbox.flush();
  post({ type: "phase", phase: "compile" });
  out("system", "system", `$ clang++ -std=${std} ${opt} ${sources.join(" ")}\n`);

  let clang: RunClang;
  try {
    if (!runClang) {
      const cfg = await remoteConfig(msg.engineBase);
      const download = !!cfg && !(await remoteCached(cfg, msg.engineBase));
      out("system", "system", download ? `(first use: downloading the C++ compiler, about ${cfg!.approxMB} MB, once)\n` : "(first run: loading the C++ compiler, this takes a moment)\n");
      let nextStep = 10;
      onProgress = download
        ? (done, total) => {
            const pct = Math.min(100, Math.floor((done / total) * 100));
            if (pct >= nextStep) {
              nextStep = pct + 10;
              out("system", "system", `  downloading... ${Math.round(done)} / ${Math.round(total)} MB\n`);
            }
          }
        : null;
    }
    clang = await load(msg.engineBase);
    onProgress = null;
  } catch (e) {
    onProgress = null;
    const cfg = await remoteConfig(msg.engineBase);
    const hint = cfg ? "\nThe C++ compiler is downloaded once on first use (internet needed). Check the connection and press Run again.\n" : "\n";
    out("compile", "stderr", `cannot load the C++ compiler: ${String((e as Error).message ?? e)}${hint}`);
    return done(null, "compile_error");
  }

  const tree: Tree = {};
  for (const [path, data] of Object.entries(msg.files)) setPath(tree, path, data);
  tree["__compieler_hook.cpp"] = enc.encode(HOOK);
  let wasm: Uint8Array | undefined;
  try {
    const result = await clang(
      ["clang++", `-std=${std}`, opt, "-fno-exceptions", "-fno-rtti", "-Wall", "-Wextra", "-ferror-limit=19", "-fmessage-length=0", "-I.", ...sources, "__compieler_hook.cpp", "-o", "main.wasm"],
      tree,
      { stdout: (b: Uint8Array | null) => emit("compile", 1, b), stderr: (b: Uint8Array | null) => emit("compile", 2, b), fetchProgress: quiet },
    );
    wasm = result["main.wasm"] as Uint8Array | undefined;
  } catch (e) {
    const code = (e as { code?: number }).code;
    for (const d of decoders.values()) out("compile", "stderr", d.decode());
    if (typeof code !== "number") out("compile", "stderr", `internal compiler error: ${String((e as Error).message ?? e)}\n`);
    return done(typeof code === "number" ? code : null, "compile_error");
  }
  if (!wasm) {
    out("compile", "stderr", "the compiler produced no output\n");
    return done(null, "compile_error");
  }

  outbox.flush();
  post({ type: "phase", phase: "run" });
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(wasm.slice());
  } catch (e) {
    out("run", "stderr", `cannot load the compiled program: ${String((e as Error).message ?? e)}\n`);
    return done(null, "error");
  }
  const files: Record<string, Uint8Array> = {};
  for (const [p, d] of Object.entries(msg.files)) files[p] = d;
  const wasi = new WasiRuntime({
    argv: ["main", ...msg.args],
    env: msg.env,
    files,
    readStdin: (max) => reader.read(max),
    onWrite: (fd, bytes) => emit("run", fd, bytes),
  });
  let code: number;
  try {
    const instance = await WebAssembly.instantiate(module, wasi.imports());
    wasi.attach(instance.exports.memory as WebAssembly.Memory);
    try {
      (instance.exports._start as () => void)();
      code = 0;
    } catch (exn) {
      if (exn instanceof ProcExit) code = exn.code;
      else throw exn;
    }
  } catch (e) {
    const err = e as Error;
    const trap = err instanceof WebAssembly.RuntimeError ? err.message : err instanceof RangeError ? "stack overflow" : err.message;
    out("run", "stderr", `\nRuntime error: ${trap}\n`);
    for (const d of decoders.values()) d.decode();
    return done(139, "error", "trap");
  }
  for (const [k, d] of decoders) {
    const rest = d.decode();
    if (rest) out(k.startsWith("run") ? "run" : "compile", k.endsWith("2") ? "stderr" : "stdout", rest);
  }
  done(code, code === 0 ? "ok" : "error");
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    if (msg.type === "init") {
      // a remote compiler is not downloaded in the background (it may be metered): only when a program is run
      const cfg = await remoteConfig(msg.engineBase);
      if (!cfg || (await remoteCached(cfg, msg.engineBase))) await load(msg.engineBase);
      post({ type: "ready" });
    } else if (msg.type === "run") {
      await run(msg);
    } else {
      out("system", "stderr", "Package installation is not available for C++.\n");
      post({ type: "done", code: 1, reason: "error", changed: {}, deleted: [], durationMs: 0 });
    }
  } catch (e) {
    out("system", "stderr", `C++ engine failed: ${String((e as Error).message ?? e)}\n`);
    post({ type: "done", code: null, reason: "error", changed: {}, deleted: [], durationMs: 0, detail: "engine" });
  }
};
