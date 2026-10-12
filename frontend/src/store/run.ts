import { create } from "zustand";
import { RunSocket } from "../api/socket";
import { LocalSocket } from "../runtime/LocalSocket";
import { STANDALONE } from "../runtime/mode";
import type { ExitReason, Problem, ServerEvent } from "../api/types";
import { stripAnsi } from "../lib/ansi";
import { basename, formatDuration, isRunnable } from "../lib/paths";
import { C, terminal } from "../lib/terminal";
import { useProject } from "./project";
import { useUI } from "./ui";

export type RunStatus = "idle" | "starting" | "queued" | "installing" | "compiling" | "running";

export interface ExitInfo {
  reason: ExitReason;
  code: number | null;
  signal: string | null;
  durationMs: number;
  phase: string;
  kind: "run" | "shell" | "install";
  detail: string;
}

interface RunState {
  status: RunStatus;
  kind: "run" | "shell" | "install" | null;
  startedAt: number | null;
  exit: ExitInfo | null;
  output: string;
  errors: string;
  problems: Problem[];
  stdinText: string;
  connection: "connecting" | "open" | "closed";
  run: () => Promise<void>;
  stop: () => void;
  shell: (command: string) => Promise<void>;
  install: (packages: string[]) => Promise<void>;
  setStdinText: (t: string) => void;
  clearOutput: () => void;
  sendLine: (line: string) => void;
  sendEof: () => void;
}

const MAX_TEXT = 2_000_000;
type Transport = RunSocket | LocalSocket;
let socket: Transport | null = null;
let socketProject = 0;
const history: string[] = [];
let historyPos = 0;

// Output arrives in many small frames; render at most once per animation frame.
let pendingOut = "";
let pendingErr = "";
let flushHandle = 0;

const REASON_TEXT: Partial<Record<ExitReason, string>> = {
  timeout: "Time limit exceeded - the program was terminated",
  cpu_limit: "CPU time limit exceeded - the program was terminated",
  memory: "Memory limit exceeded - the program was terminated",
  output_limit: "Output limit exceeded - the program was terminated",
  stopped: "Stopped by user",
  compile_error: "Compilation failed",
  install_failed: "Installing dependencies failed",
  sandbox_error: "The sandbox could not start the program (see server logs)",
};

export const useRun = create<RunState>((set, get) => {
  const toast = (t: string, k: "info" | "error" | "ok" = "info") => useUI.getState().toast(t, k);

  function scheduleFlush() {
    if (flushHandle) return;
    flushHandle = requestAnimationFrame(() => {
      flushHandle = 0;
      const o = pendingOut,
        e = pendingErr;
      pendingOut = pendingErr = "";
      set((s) => ({
        output: o ? (s.output + o).slice(-MAX_TEXT) : s.output,
        errors: e ? (s.errors + e).slice(-MAX_TEXT) : s.errors,
      }));
    });
  }

  function handle(ev: ServerEvent) {
    switch (ev.type) {
      case "start":
        set({ status: "running", kind: ev.kind, startedAt: performance.now(), exit: null });
        break;
      case "status":
        if (ev.state === "queued") {
          set({ status: "queued" });
          terminal.writeln("Waiting for a free execution slot ...", C.dim);
        }
        break;
      case "output": {
        const text = ev.data;
        if (ev.phase === "install") set({ status: "installing" });
        else if (ev.phase === "compile") set({ status: "compiling" });
        else if (ev.phase === "run" || ev.phase === "shell") set({ status: "running" });
        const clean = stripAnsi(text);
        if (ev.phase === "run") {
          if (ev.stream === "stdout") pendingOut += clean;
          else pendingErr += clean;
        } else if (ev.phase === "system") {
          if (ev.stream === "stderr") pendingErr += clean;
          else pendingOut += clean;
        } else if (ev.phase !== "shell") {
          // install / compile logs: shown in Output, errors also in Errors
          pendingOut += clean;
          if (ev.stream === "stderr") pendingErr += clean;
        }
        scheduleFlush();
        if (ev.stream === "stderr") terminal.write(text, C.red);
        else if (ev.phase === "system" || ev.phase === "install" || ev.phase === "compile") terminal.write(text, C.dim);
        else terminal.write(text);
        break;
      }
      case "problems":
        set({ problems: ev.items });
        // Compiler errors are the thing to look at; runtime errors keep the user's current tab.
        if (ev.phase === "compile" && ev.items.some((p) => p.severity === "error")) useUI.getState().setBottomTab("problems");
        break;
      case "exit": {
        const info: ExitInfo = {
          reason: ev.reason,
          code: ev.code,
          signal: ev.signal,
          durationMs: ev.duration_ms,
          phase: ev.phase,
          kind: ev.kind,
          detail: ev.detail,
        };
        set({ status: "idle", exit: info, startedAt: null });
        const ok = ev.reason === "ok";
        const msg =
          REASON_TEXT[ev.reason] ??
          (ev.signal ? `Terminated by signal ${ev.signal}` : ev.code != null && ev.code !== 0 ? `Exited with code ${ev.code}` : "Finished");
        const line = `${ok ? "Process finished" : msg}${ev.code != null ? ` (exit code ${ev.code})` : ""} in ${formatDuration(ev.duration_ms)}`;
        terminal.write(`\r\n${ok ? C.green : C.yellow}[${line}]${C.reset}\r\n`);
        pendingOut += `\n[${line}]\n`;
        if (!ok && ev.reason !== "stopped") pendingErr += `[${msg}]\n`;
        scheduleFlush();
        terminal.prompt();
        if (ev.kind === "run" || ev.kind === "install") void useProject.getState().reloadCleanBuffers();
        else void useProject.getState().refreshTree();
        if (ev.kind === "install") void useProject.getState().reloadCleanBuffers();
        break;
      }
      case "error":
        if (ev.code === "disconnected") {
          const wasBusy = get().status !== "idle";
          set({ status: "idle", startedAt: null });
          if (wasBusy) terminal.write(`\r\n${C.red}[${ev.message}]${C.reset}\r\n`);
          pendingErr += `[${ev.message}]\n`;
          scheduleFlush();
          terminal.prompt();
        } else {
          toast(ev.message, "error");
          if (ev.code === "busy" || ev.code === "rate_limited") set({ status: get().kind ? get().status : "idle" });
          if (get().status === "starting") set({ status: "idle" });
        }
        break;
      default:
        break;
    }
  }

  async function ensureSocket(): Promise<Transport | null> {
    const p = useProject.getState().project;
    if (!p) return null;
    if (!socket || socketProject !== p.id) {
      socket?.close();
      socket = STANDALONE ? new LocalSocket(p.id) : new RunSocket(p.id);
      socketProject = p.id;
      socket.on(handle);
      socket.onState((connection) => set({ connection }));
    }
    try {
      await socket.ensureOpen();
      return socket;
    } catch (e) {
      toast(e instanceof Error ? e.message : "Cannot connect", "error");
      return null;
    }
  }

  async function begin(kind: "run" | "shell" | "install", header: string, send: (s: Transport) => boolean) {
    if (get().status !== "idle") return;
    set({ status: "starting", kind });
    if (kind === "run") {
      await useProject.getState().saveAll().catch(() => undefined);
      set({ output: "", errors: "", problems: [], exit: null });
      pendingOut = pendingErr = "";
      terminal.clear();
    }
    const s = await ensureSocket();
    if (!s) {
      set({ status: "idle" });
      terminal.prompt();
      return;
    }
    if (header) terminal.writeln(header, C.cyan);
    if (!send(s)) {
      set({ status: "idle" });
      toast("Connection lost - try again", "error");
    }
  }

  // Close the socket when the user switches projects.
  useProject.subscribe((s, prev) => {
    if (s.project?.id !== prev.project?.id) {
      socket?.close();
      socket = null;
      set({ status: "idle", output: "", errors: "", problems: [], exit: null, startedAt: null });
      terminal.clear();
      terminal.writeln("Terminal - run a program, or type a shell command (pip install ..., npm install ..., ls).", C.dim);
      terminal.prompt();
    }
  });

  terminal.setHandlers({
    isRunning: () => get().status !== "idle",
    onLine: (line) => {
      if (get().status !== "idle") get().sendLine(line);
      else {
        if (line.trim()) void get().shell(line);
        else terminal.prompt();
      }
    },
    onEof: () => get().sendEof(),
    onInterrupt: () => {
      if (get().status !== "idle") get().stop();
      else terminal.prompt();
    },
    onHistory: (dir) => {
      if (!history.length) return null;
      historyPos = Math.max(0, Math.min(history.length, historyPos + dir));
      return history[historyPos] ?? "";
    },
  });

  return {
    status: "idle",
    kind: null,
    startedAt: null,
    exit: null,
    output: "",
    errors: "",
    problems: [],
    stdinText: "",
    connection: "closed",

    async run() {
      const { project, active, buffers } = useProject.getState();
      if (!project) return;
      const activeIsRunnable = !!active && isRunnable(active, project.language) && !buffers[active]?.binary;
      const entry = activeIsRunnable ? active! : project.settings.entry;
      if (!entry) {
        toast("Nothing to run - create a source file first", "error");
        return;
      }
      const st = project.settings;
      await begin("run", `$ run ${basename(entry)}`, (s) =>
        s.run({ entry, args: st.args, stdin: get().stdinText, std: st.cpp_std, opt: st.cpp_opt }),
      );
    },
    stop() {
      if (get().status === "idle") return;
      if (!socket?.stop()) set({ status: "idle" });
    },
    async shell(command) {
      history.push(command);
      historyPos = history.length;
      if (command.trim() === "clear") {
        terminal.clear();
        terminal.prompt();
        return;
      }
      await begin("shell", "", (s) => s.shell(command));
    },
    async install(packages) {
      if (!packages.length) return;
      useUI.getState().setBottomTab("terminal");
      await begin("install", `install ${packages.join(" ")}`, (s) => s.install(packages));
    },
    setStdinText: (stdinText) => set({ stdinText }),
    clearOutput: () => {
      pendingOut = pendingErr = "";
      set({ output: "", errors: "", problems: [] });
      terminal.clear();
      if (get().status === "idle") terminal.prompt();
    },
    sendLine(line) {
      socket?.stdin(line + "\n");
    },
    sendEof() {
      socket?.eof();
    },
  };
});
