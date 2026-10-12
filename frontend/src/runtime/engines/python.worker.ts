/// <reference lib="webworker" />
// Python: real CPython 3.14 compiled to WebAssembly (Pyodide) running in a Worker.
import { loadPyodide, type PyodideInterface } from "pyodide";
import type { FileMap, FromWorker, StdinInit, ToWorker } from "../protocol";
import { Outbox } from "../outbox";
import { StdinReader } from "../stdin";

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);
const outbox = new Outbox(post);
const out = (phase: "install" | "compile" | "run" | "system", stream: "stdout" | "stderr" | "system", data: string) => outbox.write(phase, stream, data);

let pyodide: PyodideInterface | null = null;
let loading: Promise<PyodideInterface> | null = null;
let reader: StdinReader | null = null;
let currentPhase: "install" | "run" | "system" = "system";
let baseModules: string[] = [];
const dec = { stdout: new TextDecoder(), stderr: new TextDecoder() };

const HARNESS = `
import sys, os, runpy, traceback, builtins

def _compieler_run(entry, args):
    os.chdir('/work')
    sys.dont_write_bytecode = True
    os.environ['MPLBACKEND'] = 'Agg'
    os.environ['PYTHONIOENCODING'] = 'utf-8'
    if '/work' not in sys.path:
        sys.path.insert(0, '/work')
    sys.argv = [entry] + list(args)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(line_buffering=True)
        except Exception:
            pass
    # forget modules of the previous run that came from the project so edits take effect
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, '__file__', None)
        if f and str(f).startswith('/work/'):
            del sys.modules[name]
    try:
        runpy.run_path('/work/' + entry, run_name='__main__')
        return 0
    except SystemExit as e:
        code = e.code
        if code is None:
            return 0
        if isinstance(code, int):
            return code
        print(code, file=sys.stderr)
        return 1
    except BaseException as e:
        tb = e.__traceback__
        while tb is not None and not str(tb.tb_frame.f_code.co_filename).startswith('/work/'):
            tb = tb.tb_next
        sys.stderr.write('Traceback (most recent call last):\\n' if tb is not None else '')
        if tb is not None:
            sys.stderr.write(''.join(traceback.format_tb(tb)))
        sys.stderr.write(''.join(traceback.format_exception_only(type(e), e)))
        return 1
    finally:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
`;

async function boot(engineBase: string): Promise<PyodideInterface> {
  if (pyodide) return pyodide;
  if (!loading) {
    loading = (async () => {
      const indexURL = engineBase + "pyodide/";
      const lock = await (await fetch(indexURL + "pyodide-lock.json")).text();
      const py = await loadPyodide({
        indexURL,
        lockFileContents: lock,
        packageBaseUrl: indexURL,
        fullStdLib: false,
        // Quiet: loader chatter is forwarded explicitly where useful.
        stdout: () => undefined,
        stderr: () => undefined,
      });
      py.setStdout({
        write: (buf: Uint8Array) => {
          out(currentPhase, "stdout", dec.stdout.decode(buf, { stream: true }));
          return buf.length;
        },
      });
      py.setStderr({
        write: (buf: Uint8Array) => {
          out(currentPhase, "stderr", dec.stderr.decode(buf, { stream: true }));
          return buf.length;
        },
      });
      py.setStdin({
        read: (buffer: Uint8Array) => {
          if (!reader) return 0;
          const chunk = reader.read(buffer.length);
          buffer.set(chunk);
          return chunk.length;
        },
        isatty: false,
      });
      py.FS.mkdirTree("/work");
      py.runPython(HARNESS);
      baseModules = py.runPython("list(__import__('sys').modules)") as unknown as string[];
      pyodide = py;
      return py;
    })();
  }
  return loading;
}

function resetWork(py: PyodideInterface, files: FileMap) {
  const FS = py.FS;
  const rm = (dir: string) => {
    for (const name of FS.readdir(dir)) {
      if (name === "." || name === "..") continue;
      const p = `${dir}/${name}`;
      const st = FS.stat(p);
      if (FS.isDir(st.mode)) {
        rm(p);
        FS.rmdir(p);
      } else FS.unlink(p);
    }
  };
  rm("/work");
  for (const [path, data] of Object.entries(files)) {
    const full = `/work/${path}`;
    FS.mkdirTree(full.slice(0, full.lastIndexOf("/")));
    FS.writeFile(full, data);
  }
}

function snapshot(py: PyodideInterface): Map<string, string> {
  const FS = py.FS;
  const res = new Map<string, string>();
  const walk = (dir: string, prefix: string) => {
    for (const name of FS.readdir(dir)) {
      if (name === "." || name === "..") continue;
      if (name === "__pycache__") continue;
      const p = `${dir}/${name}`;
      const st = FS.stat(p);
      if (FS.isDir(st.mode)) walk(p, `${prefix}${name}/`);
      else res.set(`${prefix}${name}`, `${st.size}:${+st.mtime}`);
    }
  };
  walk("/work", "");
  return res;
}

function diff(py: PyodideInterface, before: Map<string, string>): { changed: FileMap; deleted: string[] } {
  const after = snapshot(py);
  const changed: FileMap = {};
  for (const [p, sig] of after) if (before.get(p) !== sig) changed[p] = py.FS.readFile(`/work/${p}`) as Uint8Array;
  const deleted = [...before.keys()].filter((p) => !after.has(p));
  return { changed, deleted };
}

async function micropipInstall(py: PyodideInterface, packages: string[]): Promise<boolean> {
  currentPhase = "install";
  outbox.flush();
  post({ type: "phase", phase: "install" });
  try {
    await py.loadPackage("micropip");
    const micropip = py.pyimport("micropip");
    for (const spec of packages) {
      out("install", "stdout", `Installing ${spec} ...\n`);
      await micropip.install(spec);
    }
    out("install", "stdout", "Done.\n");
    return true;
  } catch (e) {
    out("install", "stderr", `${String((e as Error).message ?? e).split("\n").slice(-3).join("\n")}\n`);
    return false;
  }
}

function parseRequirements(files: FileMap): string[] {
  const raw = files["requirements.txt"];
  if (!raw) return [];
  return new TextDecoder()
    .decode(raw)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("-"));
}

async function run(msg: Extract<ToWorker, { type: "run" }>) {
  const t0 = performance.now();
  const py = await boot(msg.engineBase);
  const stdin: StdinInit = msg.stdin;
  reader = new StdinReader(stdin.sab, stdin.prefill, stdin.closed, () => (outbox.flush(), post({ type: "need-input" })), stdin.native ?? null);
  resetWork(py, msg.files);
  py.globals.set("__compieler_env", JSON.stringify(msg.env ?? {}));
  py.runPython("import os, json\nos.environ.update(json.loads(__compieler_env))\ndel __compieler_env");
  const before = snapshot(py);
  const finish = (code: number | null, reason: "ok" | "error" | "install_failed") => {
    const { changed, deleted } = diff(py, before);
    outbox.flush();
    post({ type: "done", code, reason, changed, deleted, durationMs: Math.round(performance.now() - t0) });
  };

  // Packages: requirements.txt via micropip, imports of bundled/known packages via Pyodide's loader.
  const reqs = parseRequirements(msg.files);
  if (reqs.length && !(await micropipInstall(py, reqs))) return finish(null, "install_failed");
  try {
    const sources = Object.entries(msg.files)
      .filter(([p]) => p.endsWith(".py"))
      .map(([, d]) => new TextDecoder().decode(d))
      .join("\n");
    currentPhase = "install";
    await py.loadPackagesFromImports(sources, {
      messageCallback: (m: string) => out("install", "stdout", m + "\n"),
      errorCallback: (m: string) => out("install", "stderr", m + "\n"),
    });
  } catch (e) {
    out("install", "stderr", `${String((e as Error).message ?? e)}\n`);
  }

  currentPhase = "run";
  outbox.flush();
  post({ type: "phase", phase: "run" });
  let code = 1;
  try {
    const fn = py.globals.get("_compieler_run") as unknown as {
      (entry: string, args: string[]): number;
      callPromising?: (entry: string, args: string[]) => Promise<number>;
      destroy?: () => void;
    };
    // JSPI lets asyncio.run() / run_sync() suspend the WebAssembly stack; older engines fall back to a plain call.
    const hasJspi = typeof fn.callPromising === "function" && typeof (WebAssembly as unknown as { Suspending?: unknown }).Suspending !== "undefined";
    code = Number(hasJspi ? await fn.callPromising!(msg.entry, msg.args) : fn(msg.entry, msg.args)) | 0;
    fn.destroy?.();
  } catch (e) {
    out("run", "stderr", `${String((e as Error).message ?? e)}\n`);
  }
  out("run", "stdout", dec.stdout.decode());
  out("run", "stderr", dec.stderr.decode());
  void baseModules;
  finish(code, code === 0 ? "ok" : "error");
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    if (msg.type === "init") {
      await boot(msg.engineBase);
      post({ type: "ready" });
    } else if (msg.type === "run") {
      await run(msg);
    } else if (msg.type === "install") {
      const py = await boot(msg.engineBase);
      const ok = await micropipInstall(py, msg.packages);
      post({ type: "done", code: ok ? 0 : 1, reason: ok ? "ok" : "install_failed", changed: {}, deleted: [], durationMs: 0 });
    }
  } catch (e) {
    out("system", "stderr", `Python engine failed: ${String((e as Error).message ?? e)}\n`);
    post({ type: "done", code: null, reason: "error", changed: {}, deleted: [], durationMs: 0, detail: "engine" });
  }
};
