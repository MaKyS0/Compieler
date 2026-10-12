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

async function load(base: string): Promise<RunClang> {
  if (runClang) return runClang;
  if (!loading) {
    loading = (async () => {
      const url = new URL(`${base}cpp/bundle.js`, self.location.href).href;
      const mod = (await import(/* @vite-ignore */ url)) as { runClang: RunClang };
      // warm-up: fetches and compiles the toolchain (~100 MB of WebAssembly) once
      await mod.runClang(["clang++", "--version"], {}, { stdout: quiet, stderr: quiet, fetchProgress: quiet });
      runClang = mod.runClang;
      return runClang;
    })();
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
    out("system", "system", runClang ? "" : "(first run: loading the C++ compiler, this takes a moment)\n");
    clang = await load(msg.engineBase);
  } catch (e) {
    out("compile", "stderr", `cannot load the C++ compiler: ${String((e as Error).message ?? e)}\n`);
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
      await load(msg.engineBase);
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
