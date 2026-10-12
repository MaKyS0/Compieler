/// <reference lib="webworker" />
// C++: real clang + lld (LLVM 8, compiled to WebAssembly) with a wasi-libc / libc++ sysroot.
// Programs are compiled to wasm32-wasi and executed inside this worker.
import type { FileMap, FromWorker, ToWorker } from "../protocol";
import { Outbox } from "../outbox";
import { StdinReader } from "../stdin";
import { MemFS, WasiApp, untar } from "../vendor/wasmClang";

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);
type Phase = "compile" | "run" | "system";
const outbox = new Outbox(post);
const out = (phase: Phase, stream: "stdout" | "stderr" | "system", data: string) => outbox.write(phase, stream, data);

// stdout unbuffered: a printf prompt must be visible before scanf blocks (wasi-libc buffers stdout when it is not a tty)
const HOOK = `#include <cstdio>\n__attribute__((constructor)) static void compieler_unbuffer() { std::setvbuf(stdout, nullptr, _IONBF, 0); }\n`;

interface Toolchain {
  clang: WebAssembly.Module;
  lld: WebAssembly.Module;
  memfs: WebAssembly.Module;
  sysroot: ArrayBuffer;
}
let tc: Toolchain | null = null;
let loading: Promise<Toolchain> | null = null;

async function load(base: string): Promise<Toolchain> {
  if (tc) return tc;
  if (!loading) {
    loading = (async () => {
      const get = async (name: string) => {
        const res = await fetch(`${base}cpp/${name}`);
        if (!res.ok) throw new Error(`cannot load ${name}: HTTP ${res.status}`);
        return res.arrayBuffer();
      };
      const [clang, lld, memfs, sysroot] = await Promise.all([get("clang"), get("lld"), get("memfs"), get("sysroot.tar")]);
      tc = {
        clang: await WebAssembly.compile(clang),
        lld: await WebAssembly.compile(lld),
        memfs: await WebAssembly.compile(memfs),
        sysroot,
      };
      return tc;
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

async function run(msg: Extract<ToWorker, { type: "run" }>) {
  const t0 = performance.now();
  const t = await load(msg.engineBase);
  const reader = new StdinReader(msg.stdin.sab, msg.stdin.prefill, msg.stdin.closed, () => (outbox.flush(), post({ type: "need-input" })), msg.stdin.native ?? null);
  let phase: Phase = "compile";
  const decoders = new Map<string, TextDecoder>();
  const fs = new MemFS({
    memfsModule: t.memfs,
    onWrite: (fd, bytes) => {
      const key = `${phase}${fd}`;
      let d = decoders.get(key);
      if (!d) decoders.set(key, (d = new TextDecoder()));
      out(phase, fd === 2 ? "stderr" : "stdout", d.decode(bytes, { stream: true }));
    },
    readStdin: (max) => reader.read(max),
  });
  await fs.ready;
  untar(t.sysroot, fs);

  const done = (code: number | null, reason: "ok" | "error" | "compile_error", detail?: string) =>
    (outbox.flush(),
    post({ type: "done", code, reason, changed: {}, deleted: [], durationMs: Math.round(performance.now() - t0), detail }));

  // project files
  fs.addDirectory("work");
  const dirs = new Set<string>();
  for (const [path, data] of Object.entries(msg.files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const d = "work/" + parts.slice(0, i).join("/");
      if (!dirs.has(d)) (dirs.add(d), fs.addDirectory(d));
    }
    fs.addFile("work/" + path, data);
  }
  fs.addDirectory("obj");
  fs.addFile("work/__compieler_hook.cpp", enc.encode(HOOK));

  const sources = pickSources(msg.files, msg.entry);
  if (!sources.length) {
    out("system", "stderr", "No C++ source files (.cpp, .cc, .cxx) found in the project.\n");
    return done(null, "compile_error");
  }
  const std = (msg.std ?? "c++17").replace(/^c\+\+(20|23)$/, "c++2a");
  const opt = msg.opt ?? "-O2";
  outbox.flush();
  post({ type: "phase", phase: "compile" });
  out("system", "system", `$ clang -std=${std} ${opt} ${sources.join(" ")}\n`);

  const objs: string[] = [];
  for (const [i, src] of [...sources, "__compieler_hook.cpp"].entries()) {
    const obj = `obj/${i}.o`;
    const app = new WasiApp(
      t.clang, fs, "clang", "-cc1", "-emit-obj", "-disable-free",
      "-isysroot", "/", "-internal-isystem", "/include/c++/v1", "-internal-isystem", "/include", "-internal-isystem", "/lib/clang/8.0.1/include",
      "-ferror-limit", "19", "-fmessage-length", "0", `-std=${std}`, opt, "-Wall", "-Wextra",
      "-I", "work", "-o", obj, "-x", "c++", `work/${src}`,
    );
    let code: number;
    try {
      code = await app.run();
    } catch (e) {
      out("compile", "stderr", `internal compiler error: ${String((e as Error).message ?? e)}\n`);
      return done(null, "compile_error");
    }
    if (code !== 0) return done(code, "compile_error");
    objs.push(obj);
  }
  const link = new WasiApp(
    t.lld, fs, "wasm-ld", "--no-threads", "--export-dynamic", "-z", "stack-size=1048576", "-Llib/wasm32-wasi", "lib/wasm32-wasi/crt1.o",
    ...objs, "-lc", "-lc++", "-lc++abi", "lib/clang/8.0.1/lib/wasi/libclang_rt.builtins-wasm32.a", "-o", "main.wasm",
  );
  try {
    const code = await link.run();
    if (code !== 0) return done(code, "compile_error");
  } catch (e) {
    out("compile", "stderr", `linker error: ${String((e as Error).message ?? e)}\n`);
    return done(null, "compile_error");
  }

  phase = "run";
  outbox.flush();
  post({ type: "phase", phase: "run" });
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(fs.getFileContents("main.wasm").slice());
  } catch (e) {
    out("run", "stderr", `cannot load the compiled program: ${String((e as Error).message ?? e)}\n`);
    return done(null, "error");
  }
  const prog = new WasiApp(module, fs, "main", ...msg.args);
  let code: number;
  try {
    code = await prog.run();
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
