import { Code2, FolderTree, Loader2, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { AuthModal } from "./components/AuthModal";
import { BottomPanel } from "./components/BottomPanel";
import { Dialogs } from "./components/Dialogs";
import { EditorArea } from "./components/EditorArea";
import { ProjectsModal } from "./components/ProjectsModal";
import { ActivityBar, Sidebar } from "./components/Sidebar";
import { Splitter } from "./components/Splitter";
import { StatusBar } from "./components/StatusBar";
import { SymbolBar } from "./components/SymbolBar";
import { TopBar } from "./components/TopBar";
import { useProject } from "./store/project";
import { useRun } from "./store/run";
import { useUI, type MobileView } from "./store/ui";

function useMobile() {
  const query = "(max-width: 767px)";
  const [m, setM] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        void useRun.getState().run();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void useProject.getState().saveAll();
      } else if (mod && e.key === "`") {
        e.preventDefault();
        useUI.getState().toggleBottom();
      } else if (e.shiftKey && e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        void useProject.getState().formatActive();
      }
    };
    window.addEventListener("keydown", onKey, true);
    // Warn before leaving with unsaved edits or a running program.
    const onUnload = (e: BeforeUnloadEvent) => {
      const dirty = Object.values(useProject.getState().buffers).some((b) => b.content !== b.saved);
      if (dirty) {
        void useProject.getState().saveAll().catch(() => undefined);
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);
}

function Loading({ error }: { error: string | null }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-dim">
      {error ? (
        <>
          <p className="max-w-md px-4 text-center text-[13px] text-err" role="alert">
            {error}
          </p>
          <button className="btn btn-solid" onClick={() => void useProject.getState().bootstrap()}>
            Retry
          </button>
        </>
      ) : (
        <>
          <Loader2 className="animate-spin" size={20} />
          <p className="text-[12px]">Starting workspace…</p>
        </>
      )}
    </div>
  );
}

export default function App() {
  const ready = useProject((s) => s.ready);
  const bootError = useProject((s) => s.bootError);
  const modal = useUI((s) => s.modal);
  const mobile = useMobile();
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const sidebarWidth = useUI((s) => s.sidebarWidth);
  const bottomOpen = useUI((s) => s.bottomOpen);
  const bottomHeight = useUI((s) => s.bottomHeight);
  const panelPos = useUI((s) => s.panelPos);
  const rightWidth = useUI((s) => s.rightWidth);
  const mobileView = useUI((s) => s.mobileView);
  const status = useRun((s) => s.status);
  useShortcuts();

  useEffect(() => {
    void useProject.getState().bootstrap();
  }, []);

  if (!ready) return <Loading error={bootError} />;

  const ui = useUI.getState();
  const nav: { id: MobileView; label: string; icon: React.ReactNode }[] = [
    { id: "files", label: "Files", icon: <FolderTree size={17} /> },
    { id: "editor", label: "Editor", icon: <Code2 size={17} /> },
    { id: "console", label: "Console", icon: <Terminal size={17} /> },
  ];

  return (
    <div className="flex h-full flex-col" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <TopBar mobile={mobile} />
      {mobile ? (
        <>
          <main className="min-h-0 flex-1">
            <div className="h-full" hidden={mobileView !== "files"}>
              <ActivityBarRow />
            </div>
            <div className="h-full" hidden={mobileView !== "editor"}>
              <EditorArea mobile />
            </div>
            <div className="h-full" hidden={mobileView !== "console"}>
              <BottomPanel full />
            </div>
          </main>
          {mobileView === "editor" && <SymbolBar />}
          <nav className="grid shrink-0 grid-cols-3 border-t border-line bg-panel" aria-label="Panels">
            {nav.map((n) => (
              <button
                key={n.id}
                onClick={() => ui.setMobileView(n.id)}
                aria-current={mobileView === n.id}
                className={`flex h-11 flex-col items-center justify-center gap-0.5 text-[10.5px] ${mobileView === n.id ? "text-accent" : "text-dim"}`}
              >
                <span className="relative">
                  {n.icon}
                  {n.id === "console" && status !== "idle" && <span className="absolute -right-1 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-accent" />}
                </span>
                {n.label}
              </button>
            ))}
          </nav>
        </>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ActivityBar />
          {sidebarOpen && (
            <>
              <div style={{ width: sidebarWidth }} className="min-w-0 shrink-0">
                <Sidebar />
              </div>
              <Splitter direction="col" onDrag={(d) => ui.setSidebarWidth(useUI.getState().sidebarWidth + d)} />
            </>
          )}
          {panelPos === "right" ? (
            <div className="flex min-w-0 flex-1">
              <div className="min-w-0 flex-1">
                <EditorArea mobile={false} />
              </div>
              {bottomOpen ? (
                <>
                  <Splitter direction="col" onDrag={(d) => ui.setRightWidth(useUI.getState().rightWidth - d)} />
                  <div style={{ width: rightWidth }} className="min-w-0 shrink-0">
                    <BottomPanel />
                  </div>
                </>
              ) : (
                <button
                  className="w-6 shrink-0 border-l border-line bg-panel text-[11.5px] text-dim hover:text-fg [writing-mode:vertical-rl]"
                  onClick={ui.toggleBottom}
                >
                  Show Output / Terminal panel
                </button>
              )}
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="min-h-0 flex-1">
                <EditorArea mobile={false} />
              </div>
              {bottomOpen ? (
                <>
                  <Splitter direction="row" onDrag={(d) => ui.setBottomHeight(useUI.getState().bottomHeight - d)} />
                  <div style={{ height: bottomHeight }} className="shrink-0">
                    <BottomPanel />
                  </div>
                </>
              ) : (
                <button className="h-6 shrink-0 border-t border-line bg-panel text-[11.5px] text-dim hover:text-fg" onClick={ui.toggleBottom}>
                  Show Output / Terminal panel
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <StatusBar mobile={mobile} />
      {modal === "projects" && <ProjectsModal />}
      {modal === "auth" && <AuthModal />}
      <Dialogs />
    </div>
  );
}

/** Mobile "Files" view: sidebar tabs rendered full-screen. */
function ActivityBarRow() {
  const tab = useUI((s) => s.sidebarTab);
  const setTab = useUI((s) => s.setSidebarTab);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 border-b border-line bg-panel" role="tablist">
        {(["files", "packages", "settings"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} data-active={tab === t} className="tab flex-1 justify-center capitalize" onClick={() => setTab(t)}>
            {t === "settings" ? "Run settings" : t}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <Sidebar />
      </div>
    </div>
  );
}
