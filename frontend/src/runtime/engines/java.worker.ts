/// <reference lib="webworker" />
// Java: OpenJDK's javac + the TeaVM bytecode compiler, both compiled to WebAssembly (teavm-javac).
// A program is compiled to class files, then to a WebAssembly (GC) module that runs in this worker.
// Standard input, exit status and a few library gaps are bridged by the classes in compieler-runtime.bin
// (see frontend/vendor/teavm-javac/README.md).
import type { FileMap, FromWorker, ToWorker } from "../protocol";
import { Outbox } from "../outbox";
import { StdinReader } from "../stdin";
import { readArchive, redirectStaticCalls } from "../java/classfile";

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);
type Phase = "compile" | "run" | "system";
const outbox = new Outbox(post);
const out = (phase: Phase, stream: "stdout" | "stderr" | "system", data: string) => outbox.write(phase, stream, data);

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Diagnostic {
  type: "javac" | "teavm";
  severity: "error" | "warning" | "other";
  fileName: string | null;
  lineNumber: number;
  columnNumber?: number;
  message: string;
}
interface Engine {
  load: (src: string | Uint8Array, options?: Record<string, unknown>) => Promise<{ exports: any }>;
  compiler: any;
  runtimeClasses: [string, Uint8Array][];
}

let engine: Engine | null = null;
let loading: Promise<Engine> | null = null;
let diagnostics: Diagnostic[] = [];

const url = (base: string, name: string) => new URL(`${base}java/${name}`, self.location.href).href;
const LAUNCHER_CLASS = "__CompielerMain";

async function fetchBytes(href: string): Promise<Uint8Array> {
  const res = await fetch(href);
  if (!res.ok) throw new Error(`cannot load ${href.split("/").pop()}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function load(base: string): Promise<Engine> {
  if (engine) return engine;
  loading ??= (async () => {
    const runtime = (await import(/* @vite-ignore */ url(base, "compiler.wasm-runtime.js"))) as Engine;
    const [teavm, sdk, classlib, extras] = await Promise.all([
      runtime.load(url(base, "compiler.wasm")),
      fetchBytes(url(base, "compile-classlib.bin")),
      fetchBytes(url(base, "runtime-classlib-teavm.bin")),
      fetchBytes(url(base, "compieler-runtime.bin")),
    ]);
    const compiler = teavm.exports.createCompiler();
    compiler.setSdk(new Int8Array(sdk.buffer, sdk.byteOffset, sdk.byteLength));
    compiler.setTeaVMClasslib(new Int8Array(classlib.buffer, classlib.byteOffset, classlib.byteLength));
    compiler.onDiagnostic((d: Diagnostic) => diagnostics.push(d));
    engine = { load: runtime.load, compiler, runtimeClasses: await readArchive(extras) };
    return engine;
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

const i8 = (b: Uint8Array) => new Int8Array(b.buffer, b.byteOffset, b.byteLength);
const u8 = (b: Int8Array) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/** TeaVM reports some messages with placeholders instead of names. */
const tidy = (m: string) =>
  m.replace(/\{\{c\d+\}\}/g, "a class").replace(/\{\{m\d+\}\}/g, "a method").replace(/\{\{f\d+\}\}/g, "a field").replace(/\{\{t\d+\}\}/g, "a type");

function packageOf(source: string): string {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return /^\s*package\s+([\w.]+)\s*;/m.exec(noComments)?.[1] ?? "";
}

function launcherSource(mainClass: string): string {
  return `public class ${LAUNCHER_CLASS} {
    public static void main(String[] args) {
        try {
            ${mainClass}.main(args);
        } catch (Throwable e) {
            System.out.flush();
            System.err.println("Exception in thread \\"main\\" " + e);
            System.err.flush();
            org.compieler.IO.exit(1);
            return;
        }
        System.out.flush();
        System.err.flush();
        org.compieler.IO.exit(0);
    }
}
`;
}

/** Thrown out of the program to stop it at System.exit / the end of main. */
class ExitSignal {
  constructor(public code: number) {}
}

let finishRun: ((code: number | null, reason: "ok" | "error", detail?: string) => void) | null = null;

function onAsyncError(err: unknown) {
  if (err instanceof ExitSignal || !finishRun) return true;
  const msg = runtimeMessage(err);
  out("run", "stderr", `${msg}\n`);
  finishRun(1, "error", "runtime");
  return true;
}
self.addEventListener("error", (e) => {
  if (onAsyncError(e.error)) e.preventDefault();
});
self.addEventListener("unhandledrejection", (e) => {
  if (onAsyncError(e.reason)) e.preventDefault();
});

function runtimeMessage(err: unknown): string {
  const text = String((err as Error)?.message ?? err);
  if (/null pointer|dereferencing a null/i.test(text)) return 'Exception in thread "main" java.lang.NullPointerException';
  if (err instanceof RangeError || /call stack/i.test(text)) return 'Exception in thread "main" java.lang.StackOverflowError';
  if (/out of bounds|index out of/i.test(text)) return `Exception in thread "main" java.lang.ArrayIndexOutOfBoundsException: ${text}`;
  if (/divide by zero|division by zero/i.test(text)) return 'Exception in thread "main" java.lang.ArithmeticException: / by zero';
  return `Runtime error: ${text}`;
}

async function run(msg: Extract<ToWorker, { type: "run" }>) {
  const t0 = performance.now();
  const reader = new StdinReader(msg.stdin.sab, msg.stdin.prefill, msg.stdin.closed, () => (flushStdout(), outbox.flush(), post({ type: "need-input" })), msg.stdin.native ?? null);
  let finished = false;
  const done = (code: number | null, reason: "ok" | "error" | "compile_error", detail?: string) => {
    if (finished) return;
    finished = true;
    finishRun = null;
    flushStdout();
    outbox.flush();
    post({ type: "done", code, reason, changed: {}, deleted: [], durationMs: Math.round(performance.now() - t0), detail });
  };

  // ---- sources
  const sources = Object.entries(msg.files).filter(([p]) => p.toLowerCase().endsWith(".java"));
  if (!sources.length) {
    out("system", "stderr", "No Java source files (.java) found in the project.\n");
    return done(null, "compile_error");
  }
  const byName = new Map<string, string>();
  for (const [path] of sources) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (byName.has(name)) {
      out("compile", "stderr", `${path}:1:1: error: two source files are named ${name} (${byName.get(name)} and ${path}); give them different names\n`);
      return done(1, "compile_error");
    }
    byName.set(name, path);
  }
  const dec = new TextDecoder();
  const texts = new Map(sources.map(([p, d]) => [p, dec.decode(d)]));

  outbox.flush();
  post({ type: "phase", phase: "compile" });
  out("system", "system", `$ javac ${sources.map(([p]) => p).join(" ")}\n`);
  let e: Engine;
  try {
    if (!engine) out("system", "system", "(first run: loading the Java compiler)\n");
    e = await load(msg.engineBase);
  } catch (err) {
    out("compile", "stderr", `cannot load the Java compiler: ${String((err as Error).message ?? err)}\n`);
    return done(null, "compile_error");
  }
  const c = e.compiler;

  const report = (phase: "javac" | "teavm") => {
    let errors = 0;
    for (const d of diagnostics) {
      if (d.severity === "other") continue;
      if (d.severity === "error") errors++;
      const file = d.fileName ? (byName.get(d.fileName) ?? (d.fileName === `${LAUNCHER_CLASS}.java` ? null : d.fileName)) : null;
      const where = file ? `${file}:${Math.max(1, d.lineNumber)}:${d.columnNumber && d.columnNumber > 0 ? d.columnNumber : 1}: ` : "";
      let text = tidy(d.message);
      if (phase === "teavm" && d.severity === "error") text += " (not available in the on-device Java class library)";
      out("compile", "stderr", `${where}${d.severity}: ${text}\n`);
    }
    diagnostics = [];
    return errors;
  };

  const compile = (withLauncher: string | null) => {
    c.clearSourceFiles();
    c.clearInputClassFiles();
    c.clearOutputFiles();
    for (const [name, path] of byName) c.addSourceFile(name, texts.get(path));
    for (const [name, data] of e.runtimeClasses) if (name.startsWith("org/compieler/")) c.addClassFile(name, i8(data));
    if (withLauncher) c.addSourceFile(`${LAUNCHER_CLASS}.java`, withLauncher);
    diagnostics = [];
    return c.compile() as boolean;
  };

  // 1) the user's sources alone: their diagnostics, and which classes have a main method
  let ok = compile(null);
  if (report("javac") || !ok) return done(1, "compile_error");
  const mains: string[] = (Array.from(c.detectMainClasses() as ArrayLike<string>) as string[]).map((m) => m.replace(/\//g, "."));
  const entryText = texts.get(msg.entry);
  const entryClass = entryText !== undefined ? [packageOf(entryText), msg.entry.slice(msg.entry.lastIndexOf("/") + 1).replace(/\.java$/i, "")].filter(Boolean).join(".") : "";
  const mainClass = mains.includes(entryClass) ? entryClass : mains.length === 1 ? mains[0] : "";
  if (!mainClass) {
    out(
      "compile",
      "stderr",
      mains.length
        ? `error: ${msg.entry} has no main method; classes with one: ${mains.join(", ")}. Open one of them and press Run.\n`
        : "error: no class has a method `public static void main(String[] args)`\n",
    );
    return done(1, "compile_error");
  }

  // 2) again with the launcher that starts it, then to WebAssembly
  ok = compile(launcherSource(mainClass));
  if (report("javac") || !ok) return done(1, "compile_error");
  for (const name of Array.from(c.listOutputFiles() as ArrayLike<string>) as string[]) {
    if (!name.endsWith(".class")) continue;
    const patched = redirectStaticCalls(u8(c.getOutputFile(name)), [{ owner: "java/lang/System", name: "exit", desc: "(I)V", to: "org/compieler/IO" }]);
    if (patched) c.addOutputClassFile(name, i8(patched));
  }
  for (const [name, data] of e.runtimeClasses) c.addOutputClassFile(name, i8(data));
  diagnostics = [];
  ok = c.generateWebAssembly({ outputName: "app", mainClass: LAUNCHER_CLASS });
  if (report("teavm") || !ok) return done(1, "compile_error");
  const wasm = u8(c.getWebAssemblyOutputFile("app.wasm"));

  // ---- run
  outbox.flush();
  post({ type: "phase", phase: "run" });
  let pending = "";
  let timer = 0;
  flushStdout = () => {
    if (timer) (clearTimeout(timer), (timer = 0));
    if (!pending) return;
    out("run", "stdout", pending);
    pending = "";
  };
  let stdinQueue: Uint8Array = new Uint8Array(0);
  let stdinPos = 0;
  const g = self as unknown as Record<string, unknown>;
  g.__compieler_stdin = () => {
    if (stdinPos >= stdinQueue.length) {
      flushStdout();
      stdinQueue = reader.read(65536);
      stdinPos = 0;
      if (!stdinQueue.length) return -1;
    }
    return stdinQueue[stdinPos++];
  };
  g.__compieler_exit = (code: number) => {
    done(code, code === 0 ? "ok" : "error");
    throw new ExitSignal(code);
  };
  finishRun = (code, reason, detail) => done(code, reason, detail);

  let app: { exports: any };
  try {
    app = await e.load(wasm, {
      installImports(o: any) {
        // the program writes one UTF-16 code unit at a time
        o.teavmConsole.putcharStdout = (ch: number) => {
          if (finished) return;
          pending += String.fromCharCode(ch);
          if (ch === 10 || pending.length >= 8192) flushStdout();
          else if (!timer) timer = self.setTimeout(flushStdout, 30) as unknown as number;
        };
        o.teavmConsole.putcharStderr = (ch: number) => {
          if (finished) return;
          flushStdout();
          out("run", "stderr", String.fromCharCode(ch));
        };
      },
    });
  } catch (err) {
    out("run", "stderr", `cannot load the compiled program: ${String((err as Error).message ?? err)}\n`);
    return done(null, "error");
  }
  try {
    app.exports.main(msg.args);
  } catch (err) {
    if (!(err instanceof ExitSignal)) {
      flushStdout();
      out("run", "stderr", `${runtimeMessage(err)}\n`);
      done(1, "error", "runtime");
    }
  }
  // Without an exit call yet the program is waiting (Thread.sleep, other threads): it continues from the
  // event loop and finishes through __compieler_exit; the main thread's time limit still applies.
}

let flushStdout = () => undefined as void;

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    if (msg.type === "init") {
      await load(msg.engineBase);
      post({ type: "ready" });
    } else if (msg.type === "run") {
      await run(msg);
    } else {
      out("system", "stderr", "Package installation is not available for Java.\n");
      post({ type: "done", code: 1, reason: "error", changed: {}, deleted: [], durationMs: 0 });
    }
  } catch (e) {
    out("system", "stderr", `Java engine failed: ${String((e as Error).message ?? e)}\n`);
    post({ type: "done", code: null, reason: "error", changed: {}, deleted: [], durationMs: 0, detail: "engine" });
  }
};

export type { FileMap };
