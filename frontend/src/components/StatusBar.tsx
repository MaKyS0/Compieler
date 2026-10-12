import { useEffect, useState } from "react";
import { formatDuration } from "../lib/paths";
import { useProject } from "../store/project";
import { useRun, type RunStatus } from "../store/run";
import { useUI } from "../store/ui";

const LABEL: Record<RunStatus, string> = {
  idle: "Ready",
  starting: "Starting…",
  queued: "Waiting for a free slot…",
  installing: "Installing dependencies…",
  compiling: "Compiling…",
  running: "Running…",
};

export function StatusBar({ mobile }: { mobile: boolean }) {
  const status = useRun((s) => s.status);
  const startedAt = useRun((s) => s.startedAt);
  const exit = useRun((s) => s.exit);
  const connection = useRun((s) => s.connection);
  const save = useProject((s) => s.saveStatus);
  const config = useProject((s) => s.config);
  const project = useProject((s) => s.project);
  const cursor = useUI((s) => s.cursor);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (status === "idle" || startedAt === null) return;
    const t = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(t);
  }, [status, startedAt]);

  const busy = status !== "idle";
  const dot = busy ? "bg-accent animate-pulse" : exit ? (exit.reason === "ok" ? "bg-ok" : exit.reason === "stopped" ? "bg-warn" : "bg-err") : "bg-dim";
  const elapsed = busy && startedAt !== null ? Math.max(0, (now || performance.now()) - startedAt) : null;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-2.5 text-[11.5px] text-dim" role="status" aria-live="polite">
      <span className="flex items-center gap-1.5 text-fg">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        {LABEL[status]}
        {elapsed !== null && <span className="font-mono text-dim">{formatDuration(Math.round(elapsed))}</span>}
      </span>
      {!busy && exit && exit.kind === "run" && (
        <span className="truncate">
          {exit.reason === "ok" ? "Finished" : exit.reason.replace(/_/g, " ")} · exit code {exit.code ?? exit.signal ?? "—"} · {formatDuration(exit.durationMs)}
        </span>
      )}
      <span className="flex-1" />
      {!mobile && config && (
        <span title={`Code runs in the ${config.sandbox.backend} sandbox${config.sandbox.isolation ? ` (isolation ${config.sandbox.isolation})` : ""}`}>
          {config.sandbox.backend === "on-device" ? "on-device · WebAssembly" : `sandbox: ${config.sandbox.backend}${config.sandbox.isolation ? ` ${config.sandbox.isolation}` : ""}`}
        </span>
      )}
      {connection === "closed" && busy && <span className="text-err">disconnected</span>}
      <span>{save === "saving" ? "Saving…" : save === "dirty" ? "Unsaved" : save === "error" ? <span className="text-err">Save failed</span> : "Saved"}</span>
      {!mobile && (
        <>
          <span className="font-mono">
            Ln {cursor.line}, Col {cursor.col}
          </span>
          <span>{project?.language === "cpp" ? "C++" : project?.language === "javascript" ? "JavaScript" : "Python"}</span>
        </>
      )}
    </footer>
  );
}
