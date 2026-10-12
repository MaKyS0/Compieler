import { AlertTriangle, Ban, ChevronDown, ChevronRight, CircleAlert, Eraser, Info, PanelBottom, PanelRight, Terminal as TermIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { terminal } from "../lib/terminal";
import { useProject } from "../store/project";
import { useRun } from "../store/run";
import { useUI, type BottomTab } from "../store/ui";

function LogView({ text, empty, tone }: { text: string; empty: string; tone?: "err" }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return text ? (
    <pre
      ref={ref}
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className={`h-full overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12.5px] leading-[1.45] ${tone === "err" ? "text-err" : ""}`}
    >
      {text}
    </pre>
  ) : (
    <p className="p-3 text-[12px] text-dim">{empty}</p>
  );
}

function TerminalView() {
  const host = useRef<HTMLDivElement>(null);
  const theme = useUI((s) => s.theme);
  const fontSize = useUI((s) => s.fontSize);
  useEffect(() => {
    if (!host.current) return;
    terminal.attach(host.current);
    return () => terminal.detach();
  }, []);
  useEffect(() => terminal.setTheme(theme), [theme]);
  useEffect(() => terminal.setFontSize(fontSize), [fontSize]);
  return <div ref={host} className="h-full bg-panel" onClick={() => terminal.focus()} />;
}

function InputView() {
  const text = useRun((s) => s.stdinText);
  const set = useRun((s) => s.setStdinText);
  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <p className="text-[12px] leading-relaxed text-dim">
        Text entered here is sent to the program's <b className="text-fg">stdin</b> when you press Run, followed by end-of-file. Leave it empty to type input interactively in the
        <b className="text-fg"> Terminal</b> tab while the program runs.
      </p>
      <textarea
        value={text}
        onChange={(e) => set(e.target.value)}
        spellCheck={false}
        placeholder={"One value per line, e.g.\nAlice\n42"}
        className="min-h-0 w-full flex-1 resize-none rounded border border-line bg-bg p-2 font-mono text-[12.5px] text-fg placeholder:text-dim"
        aria-label="Standard input"
      />
    </div>
  );
}

function ProblemsView() {
  const problems = useRun((s) => s.problems);
  const setMobile = useUI((s) => s.setMobileView);
  if (!problems.length) return <p className="p-3 text-[12px] text-dim">No problems. Compiler diagnostics and error locations from your last run appear here.</p>;
  return (
    <ul className="h-full overflow-auto py-1">
      {problems.map((p, i) => (
        <li key={i}>
          <button
            className="flex w-full items-start gap-2 px-3 py-1 text-left text-[12.5px] hover:bg-raised"
            onClick={async () => {
              await useProject.getState().openFile(p.file);
              setMobile("editor");
              setTimeout(() => import("../lib/editorBus").then((m) => m.editorBus.reveal(p.line, p.col || 1)), 80);
            }}
          >
            {p.severity === "error" ? <CircleAlert size={14} className="mt-0.5 shrink-0 text-err" /> : p.severity === "warning" ? <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" /> : <Info size={14} className="mt-0.5 shrink-0 text-accent" />}
            <span className="min-w-0 flex-1 break-words">{p.message}</span>
            <span className="shrink-0 font-mono text-[11px] text-dim">
              {p.file}:{p.line}:{p.col}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function BottomPanel({ full }: { full?: boolean }) {
  const tab = useUI((s) => s.bottomTab);
  const setTab = useUI((s) => s.setBottomTab);
  const toggle = useUI((s) => s.toggleBottom);
  const panelPos = useUI((s) => s.panelPos);
  const setPanelPos = useUI((s) => s.setPanelPos);
  const output = useRun((s) => s.output);
  const errors = useRun((s) => s.errors);
  const problems = useRun((s) => s.problems);
  const status = useRun((s) => s.status);
  const clear = useRun((s) => s.clearOutput);
  const stop = useRun((s) => s.stop);
  const stdinText = useRun((s) => s.stdinText);

  const tabs: { id: BottomTab; label: string; badge?: number; tone?: string }[] = [
    { id: "output", label: "Output" },
    { id: "errors", label: "Errors", badge: errors ? 1 : 0, tone: "bg-err" },
    { id: "terminal", label: "Terminal" },
    { id: "input", label: "Input" },
    { id: "problems", label: "Problems", badge: problems.length, tone: problems.some((p) => p.severity === "error") ? "bg-err" : "bg-warn" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div role="tablist" className="flex h-8 shrink-0 items-center border-b border-line">
        <div className="flex min-w-0 flex-1 overflow-x-auto">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} data-active={tab === t.id} className="tab" onClick={() => setTab(t.id)}>
              {t.id === "terminal" && <TermIcon size={12} />}
              {t.label}
              {!!t.badge && (
                <span className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium text-white ${t.tone}`}>{t.id === "errors" ? "!" : t.badge}</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center pr-1">
          {status !== "idle" && (
            <button className="btn !h-6 btn-stop" onClick={stop} title="Stop the running program">
              <Ban size={12} /> Stop
            </button>
          )}
          <button className="btn !h-6 !px-1.5" onClick={clear} title="Clear output" aria-label="Clear output">
            <Eraser size={13} />
          </button>
          {!full && (
            <button
              className="btn !h-6 !px-1.5"
              onClick={() => setPanelPos(panelPos === "right" ? "bottom" : "right")}
              title={panelPos === "right" ? "Move panel to the bottom" : "Move panel to the right"}
              aria-label={panelPos === "right" ? "Move panel to the bottom" : "Move panel to the right"}
            >
              {panelPos === "right" ? <PanelBottom size={14} /> : <PanelRight size={14} />}
            </button>
          )}
          {!full && (
            <button className="btn !h-6 !px-1.5" onClick={toggle} title="Hide panel" aria-label="Hide panel">
              {panelPos === "right" ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tab === "output" && (
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <LogView text={output} empty="Run your code to see its output here." />
            </div>
            {status !== "idle" && !stdinText && (
              <button className="shrink-0 border-t border-line bg-raised px-3 py-1 text-left text-[11.5px] text-dim hover:text-fg" onClick={() => setTab("terminal")}>
                Running. If the program is waiting for input, type it in the <b className="text-accent">Terminal</b> tab →
              </button>
            )}
          </div>
        )}
        {tab === "errors" && <LogView text={errors} tone="err" empty="No errors." />}
        {tab === "terminal" && <TerminalView />}
        {tab === "input" && <InputView />}
        {tab === "problems" && <ProblemsView />}
      </div>
    </div>
  );
}
