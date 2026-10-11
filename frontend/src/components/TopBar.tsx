import { Check, FolderOpen, Loader2, Moon, Play, Save, Square, Sun, User, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Language } from "../api/types";
import { useProject } from "../store/project";
import { useRun } from "../store/run";
import { useUI } from "../store/ui";

const LANGS: { id: Language; label: string; short: string }[] = [
  { id: "python", label: "Python", short: "Py" },
  { id: "cpp", label: "C++", short: "C++" },
  { id: "javascript", label: "JavaScript", short: "JS" },
];

function ProjectName() {
  const project = useProject((s) => s.project)!;
  const [value, setValue] = useState(project.name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(project.name), [project.name, project.id]);
  const commit = () => {
    if (value.trim() && value !== project.name) void useProject.getState().renameProject(value);
    else setValue(project.name);
  };
  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") ref.current?.blur();
        if (e.key === "Escape") (setValue(project.name), ref.current?.blur());
      }}
      aria-label="Project name"
      maxLength={120}
      className="h-7 w-full min-w-0 max-w-[220px] rounded border border-transparent bg-transparent px-1.5 text-[13px] font-medium hover:border-line focus:border-accent focus:bg-bg"
    />
  );
}

export function TopBar({ mobile }: { mobile: boolean }) {
  const project = useProject((s) => s.project)!;
  const user = useProject((s) => s.user);
  const saveStatus = useProject((s) => s.saveStatus);
  const config = useProject((s) => s.config);
  const status = useRun((s) => s.status);
  const { run, stop } = useRun.getState();
  const theme = useUI((s) => s.theme);
  const toggleTheme = useUI((s) => s.toggleTheme);
  const openModal = useUI((s) => s.openModal);
  const busy = status !== "idle";
  const canFormat = config?.formatters[project.language] !== false;

  const onRun = () => {
    if (mobile) {
      useUI.getState().setMobileView("console");
    }
    // Keep the user's tab (Terminal / Input) - only leave Errors/Problems for a fresh run.
    const cur = useUI.getState().bottomTab;
    useUI.getState().setBottomTab(cur === "errors" || cur === "problems" ? "output" : cur);
    void run();
  };

  const save = async () => {
    try {
      await useProject.getState().saveAll();
      useUI.getState().toast("Saved", "ok");
    } catch {
      /* error toast already shown */
    }
  };

  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
      {!mobile && (
        <div className="flex items-center gap-1.5 pr-1 font-mono text-[13px] font-semibold tracking-tight" aria-label="Compieler">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-accent text-[11px] font-bold text-bg">&gt;_</span>
          <span className="hidden lg:inline">Compieler</span>
        </div>
      )}
      <ProjectName />
      <div role="radiogroup" aria-label="Language" className="flex shrink-0 overflow-hidden rounded border border-line">
        {LANGS.map((l) => (
          <button
            key={l.id}
            role="radio"
            aria-checked={project.language === l.id}
            disabled={busy}
            onClick={() => void useProject.getState().setLanguage(l.id)}
            className={`h-6 px-2 text-[12px] transition-colors ${project.language === l.id ? "bg-accent/20 text-fg" : "text-dim hover:bg-raised hover:text-fg"} disabled:opacity-50`}
            title={`Switch project to ${l.label}`}
          >
            {mobile ? l.short : l.label}
          </button>
        ))}
      </div>
      <div className="flex-1" />
      {!mobile && (
        <>
          <button className="btn" onClick={() => void useProject.getState().formatActive()} disabled={!canFormat} title="Format code (Shift+Alt+F)">
            <WandSparkles size={14} /> Format
          </button>
          <button className="btn" onClick={() => void save()} title="Save all files (Ctrl+S)">
            {saveStatus === "saving" ? <Loader2 size={14} className="animate-spin" /> : saveStatus === "saved" ? <Check size={14} className="text-ok" /> : <Save size={14} />} Save
          </button>
        </>
      )}
      {busy ? (
        <button className="btn btn-stop" onClick={stop} aria-label="Stop" title="Stop the program">
          <Square size={13} fill="currentColor" /> Stop
        </button>
      ) : (
        <button className="btn btn-run" onClick={onRun} aria-label="Run" title="Run (Ctrl+Enter)">
          <Play size={13} fill="currentColor" /> Run
        </button>
      )}
      {mobile && (
        <button className="btn !px-1.5" onClick={() => void useProject.getState().formatActive()} aria-label="Format code" disabled={!canFormat}>
          <WandSparkles size={15} />
        </button>
      )}
      <button className="btn !px-1.5" onClick={() => openModal("projects")} aria-label="Projects" title="Projects">
        <FolderOpen size={15} />
      </button>
      <button className="btn !px-1.5" onClick={toggleTheme} aria-label="Toggle theme" title={theme === "dark" ? "Light theme" : "Dark theme"}>
        {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      </button>
      <button className="btn !px-1.5" onClick={() => openModal("auth")} aria-label="Account" title={user?.is_guest ? "Guest - sign in to keep your projects" : user?.email ?? "Account"}>
        <User size={15} className={user?.is_guest ? "" : "text-accent"} />
      </button>
    </header>
  );
}
