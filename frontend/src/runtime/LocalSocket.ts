/**
 * Drop-in replacement for RunSocket in the standalone build: instead of talking to a backend over a
 * WebSocket it runs the project in an engine Worker (Pyodide / V8 + Node shim / clang-wasm) and emits the
 * same events, so the UI code does not know the difference.
 */
import { collectDeviceInfo } from "./device";
import { localApi } from "../api/local";
import type { Problem, RunRequest, ServerEvent } from "../api/types";
import { db } from "./db";
import * as diag from "./diagnostics";
import { engineBase } from "./mode";
import type { FileMap, FromWorker, StdinInit, ToWorker } from "./protocol";
import { runShell } from "./shell";
import { StdinFeeder, androidBridge, canShare, createStdinBuffer } from "./stdin";

type Listener = (ev: ServerEvent) => void;
type StateListener = (state: "connecting" | "open" | "closed") => void;
type Lang = "python" | "cpp" | "javascript";

interface Job {
  kind: "run" | "shell" | "install";
  lang: Lang;
  worker: Worker;
  feeder: StdinFeeder;
  sab: SharedArrayBuffer | null;
  gen: number | null;
  timer: number;
  stopped: boolean;
  finished: boolean;
  text: Record<string, string>; // collected output per "phase:stream"
  started: number;
}

const WALL_SECONDS = 60;

function spawn(lang: Lang): Worker {
  switch (lang) {
    case "python":
      return new Worker(new URL("./engines/python.worker.ts", import.meta.url), { type: "module" });
    case "cpp":
      return new Worker(new URL("./engines/cpp.worker.ts", import.meta.url), { type: "module" });
    default:
      return new Worker(new URL("./engines/js.worker.ts", import.meta.url), { type: "module" });
  }
}

export class LocalSocket {
  state: "connecting" | "open" | "closed" = "open";
  private listeners = new Set<Listener>();
  private stateListeners = new Set<StateListener>();
  private job: Job | null = null;
  private warm = new Map<Lang, Worker>();

  constructor(private projectId: number) {
    void db.getProject(projectId).then((p) => p && this.prewarm(p.language));
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  onState(l: StateListener) {
    this.stateListeners.add(l);
    return () => this.stateListeners.delete(l);
  }
  ensureOpen(): Promise<void> {
    return Promise.resolve();
  }
  private emit(ev: ServerEvent) {
    this.listeners.forEach((l) => l(ev));
  }
  private sys(text: string, stream: "stdout" | "stderr" | "system" = "system") {
    this.emit({ type: "output", phase: "system", stream, data: text });
  }

  /** Python and C++ engines take seconds to load: start that while the user is still typing. */
  private prewarm(lang: Lang) {
    if (lang === "javascript" || this.warm.has(lang) || this.state === "closed") return;
    const w = spawn(lang);
    w.postMessage({ type: "init", engineBase: engineBase() } satisfies ToWorker);
    this.warm.set(lang, w);
  }
  private takeWorker(lang: Lang): Worker {
    if (lang === "javascript") return spawn(lang);
    const w = this.warm.get(lang) ?? spawn(lang);
    this.warm.delete(lang);
    return w;
  }

  // ------------------------------------------------------------------------------- public API
  run(req: RunRequest): boolean {
    void this.startRun("run", req);
    return true;
  }
  shell(command: string): boolean {
    void runShell(command, {
      projectId: this.projectId,
      write: (stream, data) => this.emit({ type: "output", phase: "shell", stream, data }),
      start: () => this.emit({ type: "start", kind: "shell" }),
      end: (code) => this.emit({ type: "exit", kind: "shell", phase: "shell", code, signal: null, reason: code === 0 ? "ok" : "error", duration_ms: 0, detail: "" }),
      busy: () => this.job !== null,
      run: (req) => this.startRun("shell", req),
      install: (packages) => this.install(packages),
    });
    return true;
  }
  install(packages: string[]): boolean {
    void this.startInstall(packages);
    return true;
  }
  stdin(data: string): boolean {
    this.job?.feeder.push(data);
    return true;
  }
  eof(): boolean {
    this.job?.feeder.end();
    return true;
  }
  stop(): boolean {
    const j = this.job;
    if (!j) return false;
    j.stopped = true;
    this.kill(j);
    this.finish(j, { code: null, reason: "stopped", duration: Date.now() - j.started, detail: "" });
    return true;
  }
  close() {
    this.state = "closed";
    this.listeners.clear();
    this.stateListeners.clear();
    this.job?.worker.terminate();
    this.warm.forEach((w) => w.terminate());
    this.warm.clear();
  }

  // ------------------------------------------------------------------------------- jobs
  private kill(j: Job) {
    window.clearTimeout(j.timer);
    j.worker.terminate();
  }

  private begin(kind: Job["kind"], lang: Lang): Job {
    const sab = createStdinBuffer();
    const bridge = sab ? null : androidBridge(); // no shared memory (WebView): native stdin channel
    const gen = bridge ? bridge.stdinReset() : null;
    const worker = this.takeWorker(lang);
    const j: Job = { kind, lang, worker, feeder: new StdinFeeder(sab, bridge), sab, gen, timer: 0, stopped: false, finished: false, text: {}, started: Date.now() };
    this.job = j;
    this.emit({ type: "start", kind });
    this.emit({ type: "problems", items: [] });
    return j;
  }

  private attach(j: Job, onDone: (m: Extract<FromWorker, { type: "done" }>) => void) {
    j.worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (j.finished) return;
      if (m.type === "out") {
        const key = `${m.phase}:${m.stream}`;
        j.text[key] = (j.text[key] ?? "") + m.data;
        this.emit({ type: "output", phase: m.phase, stream: m.stream, data: m.data });
      } else if (m.type === "graphics") this.emit({ type: "graphics", kind: m.kind, svg: m.svg });
      else if (m.type === "need-input") j.feeder.needInput();
      else if (m.type === "done") onDone(m);
    };
    j.worker.onerror = (e) => {
      if (j.finished) return;
      this.sys(`The ${j.lang} engine crashed: ${e.message || "unknown error"}\n`, "stderr");
      this.kill(j);
      this.finish(j, { code: null, reason: "sandbox_error", duration: Date.now() - j.started, detail: "engine crashed" });
    };
    j.timer = window.setTimeout(() => {
      if (j.finished) return;
      this.sys(`\n[Time limit of ${WALL_SECONDS}s exceeded]\n`, "stderr");
      this.kill(j);
      this.finish(j, { code: null, reason: "timeout", duration: WALL_SECONDS * 1000, detail: `Time limit of ${WALL_SECONDS}s exceeded` });
    }, WALL_SECONDS * 1000);
  }

  private finish(j: Job, r: { code: number | null; reason: string; duration: number; detail: string; problems?: Problem[] }) {
    if (j.finished) return;
    j.finished = true;
    window.clearTimeout(j.timer);
    if (this.job === j) this.job = null;
    if (r.problems?.length) this.emit({ type: "problems", items: r.problems, phase: r.reason === "compile_error" ? "compile" : "run" });
    this.emit({
      type: "exit",
      kind: j.kind,
      phase: r.reason === "compile_error" ? "compile" : r.reason === "install_failed" ? "install" : "run",
      code: r.code,
      signal: null,
      reason: r.reason as never,
      duration_ms: r.duration,
      detail: r.detail,
    });
    // a terminated warm engine is replaced in the background so the next run starts quickly
    void db.getProject(this.projectId).then((p) => p && this.prewarm(p.language));
  }

  private async startRun(kind: "run" | "shell", req: RunRequest) {
    if (this.job) return this.emit({ type: "error", code: "busy", message: "A program is already running." });
    const project = await db.getProject(this.projectId);
    if (!project) return this.emit({ type: "error", code: "bad_request", message: "Project no longer exists." });
    const lang = project.language;
    const files: FileMap = await localApi.snapshot(this.projectId);
    const entry = req.entry || (project.settings.entry as string | undefined) || "";
    const j = this.begin(kind, lang);
    if (!entry || !files[entry]) {
      this.sys(`Entry file '${entry || "?"}' does not exist. Create it or choose another file to run.\n`, "stderr");
      this.kill(j);
      return this.finish(j, { code: null, reason: "error", duration: 0, detail: "" });
    }
    const prefill = req.stdin ?? "";
    const stdin: StdinInit = { sab: j.sab, prefill, closed: prefill !== "", native: j.gen !== null && prefill === "" ? { gen: j.gen } : null };
    if (!j.sab && j.gen === null && prefill === "") this.sys("(interactive input is unavailable in this browser context; type your input in the Input tab before pressing Run)\n");
    if (prefill !== "") j.feeder.end();
    let args: string[] = [];
    try {
      args = tokenize(req.args ?? "");
    } catch {
      /* ignore bad quoting */
    }
    this.attach(j, (m) => void this.onDone(j, m, files, lang));
    const env = await collectDeviceInfo().catch(() => ({}));
    j.worker.postMessage({ type: "run", engineBase: engineBase(), files, entry, args, stdin, std: req.std, opt: req.opt, env } satisfies ToWorker);
  }

  private async startInstall(packages: string[]) {
    if (this.job) return this.emit({ type: "error", code: "busy", message: "A program is already running." });
    const project = await db.getProject(this.projectId);
    if (!project) return;
    if (project.language !== "python") {
      this.emit({ type: "start", kind: "install" });
      this.sys(project.language === "javascript" ? "npm packages are fetched from a CDN automatically when your program requires them (internet needed).\n" : "Package installation is not available for C++.\n");
      return this.emit({ type: "exit", kind: "install", phase: "install", code: 0, signal: null, reason: project.language === "javascript" ? "ok" : "error", duration_ms: 0, detail: "" });
    }
    const j = this.begin("install", "python");
    this.attach(j, (m) => {
      const reason = m.reason === "ok" ? "ok" : "install_failed";
      if (reason === "ok") void this.recordRequirements(packages);
      this.finish(j, { code: m.code, reason, duration: m.durationMs, detail: "" });
    });
    j.worker.postMessage({ type: "install", engineBase: engineBase(), packages } satisfies ToWorker);
  }

  private async recordRequirements(pkgs: string[]) {
    const files = await localApi.snapshot(this.projectId);
    const current = files["requirements.txt"] ? new TextDecoder().decode(files["requirements.txt"]) : "";
    const have = new Set(current.split("\n").map((l) => l.trim().split(/[<>=!~[; ]/)[0].toLowerCase().replace(/_/g, "-")));
    const add = pkgs.filter((p) => !have.has(p.split(/[<>=!~[; ]/)[0].toLowerCase().replace(/_/g, "-")));
    if (add.length) await localApi.writeFile(this.projectId, "requirements.txt", current.replace(/\n*$/, current.trim() ? "\n" : "") + add.join("\n") + "\n");
  }

  private async onDone(j: Job, m: Extract<FromWorker, { type: "done" }>, before: FileMap, lang: Lang) {
    if (j.finished) return;
    try {
      await localApi.applyChanges(this.projectId, m.changed, m.deleted);
    } catch (e) {
      this.sys(`Could not save files written by the program: ${(e as Error).message}\n`, "stderr");
    }
    void before;
    const run = (s: "stdout" | "stderr") => j.text[`run:${s}`] ?? "";
    let problems: Problem[] = [];
    let hintText = "";
    if (m.reason === "compile_error") {
      const compile = (j.text["compile:stderr"] ?? "") + (j.text["compile:stdout"] ?? "") + (j.text["system:stderr"] ?? "");
      problems = diag.parseClang(compile, "work");
      hintText = diag.hints(lang, compile, "compile").join("\n");
    } else if (m.reason === "error") {
      const err = run("stderr");
      problems = lang === "python" ? diag.parsePython(err, "/work") : lang === "javascript" ? diag.parseNode(err, "/work") : [];
      hintText = diag.hints(lang, err, "run").join("\n");
    } else if (m.reason === "install_failed") {
      hintText = diag.hints(lang, (j.text["install:stderr"] ?? "") + (j.text["system:stderr"] ?? ""), "install").join("\n");
    }
    if (hintText) for (const h of hintText.split("\n")) this.sys(`\n[hint] ${h}\n`);
    if (j.lang !== "javascript") {
      /* warm workers are reused, nothing to terminate */
    } else j.worker.terminate();
    if (j.lang !== "javascript" && m.detail !== "engine") this.warm.set(j.lang, j.worker);
    this.finish(j, { code: m.code, reason: m.reason, duration: m.durationMs, detail: "", problems });
  }
}

/** Splits an argument string the way a shell would (quotes, backslashes). */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") (quote = c), (has = true);
    else if (c === "\\" && i + 1 < s.length) (cur += s[++i]), (has = true);
    else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (quote) throw new Error("unterminated quote");
  if (cur || has) out.push(cur);
  return out;
}

export { canShare };
