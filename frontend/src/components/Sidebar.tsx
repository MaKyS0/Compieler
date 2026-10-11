import { FolderTree, Loader2, Package, Plus, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { isRunnable } from "../lib/paths";
import { useProject } from "../store/project";
import { useRun } from "../store/run";
import { useUI, type SidebarTab } from "../store/ui";
import { FileTree } from "./FileTree";

export function ActivityBar() {
  const tab = useUI((s) => s.sidebarTab);
  const open = useUI((s) => s.sidebarOpen);
  const setTab = useUI((s) => s.setSidebarTab);
  const toggle = useUI((s) => s.toggleSidebar);
  const items: { id: SidebarTab; icon: React.ReactNode; label: string }[] = [
    { id: "files", icon: <FolderTree size={17} />, label: "Files" },
    { id: "packages", icon: <Package size={17} />, label: "Packages" },
    { id: "settings", icon: <Settings2 size={17} />, label: "Run settings" },
  ];
  return (
    <nav className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-1.5" aria-label="Sidebar views">
      {items.map((i) => (
        <button
          key={i.id}
          title={i.label}
          aria-label={i.label}
          aria-pressed={open && tab === i.id}
          onClick={() => (open && tab === i.id ? toggle() : setTab(i.id))}
          className={`flex h-8 w-8 items-center justify-center rounded ${open && tab === i.id ? "bg-raised text-fg" : "text-dim hover:text-fg"}`}
        >
          {i.icon}
        </button>
      ))}
    </nav>
  );
}

function PackagesPanel() {
  const project = useProject((s) => s.project)!;
  const status = useRun((s) => s.status);
  const install = useRun((s) => s.install);
  const [value, setValue] = useState("");
  const [deps, setDeps] = useState<string[] | null>(null);
  const supported = project.language !== "cpp";
  const manifest = project.language === "python" ? "requirements.txt" : "package.json";

  useEffect(() => {
    if (!supported || status !== "idle") return;
    let cancelled = false;
    api
      .readFile(project.id, manifest)
      .then((f) => {
        if (cancelled) return;
        if (project.language === "python") setDeps(f.content.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
        else {
          try {
            const j = JSON.parse(f.content);
            setDeps(Object.entries({ ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) }).map(([k, v]) => `${k}@${v}`));
          } catch {
            setDeps([]);
          }
        }
      })
      .catch(() => !cancelled && setDeps([]));
    return () => {
      cancelled = true;
    };
  }, [project.id, project.language, status, supported, manifest]);

  if (!supported)
    return (
      <div className="p-3 text-[12px] leading-relaxed text-dim">
        C++ projects use the compiler's standard library and any headers you add to the project. Package managers are available for Python (pip) and JavaScript (npm).
      </div>
    );

  const busy = status !== "idle";
  const submit = () => {
    const pkgs = value.split(/[\s,]+/).filter(Boolean);
    if (!pkgs.length || busy) return;
    void install(pkgs);
    setValue("");
  };

  return (
    <div className="flex h-full flex-col">
      <div className="h-8 shrink-0 border-b border-line px-3 text-[11px] font-medium uppercase leading-8 tracking-wide text-dim">Packages · {project.language === "python" ? "pip" : "npm"}</div>
      <form
        className="flex gap-1.5 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input className="field" placeholder={project.language === "python" ? "requests, numpy==2.1" : "lodash, express"} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Package names" spellCheck={false} autoCapitalize="off" />
        <button className="btn btn-solid shrink-0" disabled={busy || !value.trim()} title="Install">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add
        </button>
      </form>
      <p className="px-3 pb-2 text-[11.5px] leading-snug text-dim">
        Installs into this project's own {project.language === "python" ? "virtual environment (.venv)" : "node_modules"} and records it in <code className="font-mono">{manifest}</code>. Packages are cached, so they are not reinstalled on every run.
      </p>
      <div className="min-h-0 flex-1 overflow-auto border-t border-line">
        <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-dim">Declared in {manifest}</div>
        {deps === null ? null : deps.length === 0 ? (
          <p className="px-3 text-[12px] text-dim">Nothing yet.</p>
        ) : (
          <ul>
            {deps.map((d) => (
              <li key={d} className="flex items-center gap-2 px-3 py-1 font-mono text-[12px]">
                <Package size={12} className="shrink-0 text-dim" /> <span className="truncate">{d}</span>
              </li>
            ))}
          </ul>
        )}
        <button className="btn mx-2 mt-2 text-accent" onClick={() => void useProject.getState().openFile(manifest)}>
          Open {manifest}
        </button>
      </div>
    </div>
  );
}

function SettingsPanel() {
  const project = useProject((s) => s.project)!;
  const tree = useProject((s) => s.tree);
  const config = useProject((s) => s.config);
  const { setSettings } = useProject.getState();
  const fontSize = useUI((s) => s.fontSize);
  const setFontSize = useUI((s) => s.setFontSize);
  const st = project.settings;
  const [args, setArgs] = useState(st.args ?? "");
  useEffect(() => setArgs(st.args ?? ""), [st.args, project.id]);
  const files = tree.filter((e) => e.type === "file" && isRunnable(e.path, project.language)).map((e) => e.path);
  const lim = config?.limits;

  return (
    <div className="h-full overflow-auto">
      <div className="h-8 border-b border-line px-3 text-[11px] font-medium uppercase leading-8 tracking-wide text-dim">Run settings</div>
      <div className="flex flex-col gap-3 p-3">
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-dim">Entry file (used when the open file can't be run)</span>
          <select className="field" value={st.entry ?? ""} onChange={(e) => void setSettings({ entry: e.target.value })}>
            {!files.includes(st.entry ?? "") && <option value={st.entry ?? ""}>{st.entry || "—"}</option>}
            {files.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-dim">Command-line arguments</span>
          <input className="field font-mono" value={args} onChange={(e) => setArgs(e.target.value)} onBlur={() => args !== (st.args ?? "") && void setSettings({ args })} placeholder="--verbose input.txt" spellCheck={false} />
        </label>
        {project.language === "cpp" && (
          <>
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="text-dim">C++ standard</span>
              <select className="field" value={st.cpp_std ?? "c++17"} onChange={(e) => void setSettings({ cpp_std: e.target.value as "c++17" })}>
                {(config?.cpp_standards ?? ["c++17", "c++20", "c++23"]).map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="text-dim">Optimization</span>
              <select className="field" value={st.cpp_opt ?? "-O2"} onChange={(e) => void setSettings({ cpp_opt: e.target.value as "-O2" })}>
                {["-O0", "-O1", "-O2", "-O3"].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-dim">Editor font size · {fontSize}px</span>
          <input type="range" min={10} max={24} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} />
        </label>
        {lim && (
          <div className="rounded border border-line bg-bg p-2 text-[11.5px] leading-relaxed text-dim">
            <div className="mb-1 font-medium text-fg">Sandbox limits</div>
            Time {lim.run_wall_seconds}s · CPU {lim.run_cpu_seconds}s · Memory {lim.memory_mb} MB · Output {Math.round(lim.max_output_bytes / 1000)} KB
            <br />
            Network disabled while your program runs{config?.allow_runtime_network ? " (unless enabled by the host)" : ""}; only package installs can reach PyPI / npm.
            <br />
            Isolation: {config?.sandbox.backend}
            {config?.sandbox.isolation ? ` (${config.sandbox.isolation})` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

export function Sidebar() {
  const tab = useUI((s) => s.sidebarTab);
  return (
    <aside className="h-full min-h-0 min-w-0 bg-panel" aria-label="Sidebar">
      {tab === "files" && <FileTree />}
      {tab === "packages" && <PackagesPanel />}
      {tab === "settings" && <SettingsPanel />}
    </aside>
  );
}
