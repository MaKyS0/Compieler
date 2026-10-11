import Editor from "@monaco-editor/react";
import { FileWarning, Loader2, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import { editorBus } from "../lib/editorBus";
import { basename, monacoLanguage } from "../lib/paths";
import { setupMonaco, monaco } from "../monaco/setup";
import { useProject } from "../store/project";
import { useRun } from "../store/run";
import { useUI } from "../store/ui";

setupMonaco();

const uriFor = (projectId: number, path: string) => `file:///p${projectId}/${path}`;

export function EditorArea({ mobile }: { mobile: boolean }) {
  const project = useProject((s) => s.project);
  const tabs = useProject((s) => s.tabs);
  const active = useProject((s) => s.active);
  const buffers = useProject((s) => s.buffers);
  const problems = useRun((s) => s.problems);
  const theme = useUI((s) => s.theme);
  const fontSize = useUI((s) => s.fontSize);
  const setCursor = useUI((s) => s.setCursor);
  const { setActive, closeTab, edit } = useProject.getState();
  const buf = active ? buffers[active] : undefined;

  // Mirror run problems into editor squiggles.
  useEffect(() => {
    if (!project) return;
    const byFile = new Map<string, typeof problems>();
    for (const p of problems) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
    for (const model of monaco.editor.getModels()) {
      const rel = model.uri.path.replace(new RegExp(`^/p${project.id}/`), "");
      const items = byFile.get(rel) ?? [];
      monaco.editor.setModelMarkers(
        model,
        "compieler",
        items.map((p) => ({
          severity: p.severity === "error" ? monaco.MarkerSeverity.Error : p.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
          message: p.message,
          startLineNumber: p.line,
          startColumn: p.col || 1,
          endLineNumber: p.line,
          endColumn: model.getLineMaxColumn(Math.min(p.line, model.getLineCount())),
          source: p.source,
        })),
      );
    }
  }, [problems, project, active, tabs, buffers]);

  // Show the first failing file straight away.
  useEffect(() => {
    const first = problems.find((p) => p.severity === "error");
    if (first && useProject.getState().tree.some((e) => e.path === first.file)) {
      void useProject.getState().openFile(first.file).then(() => setTimeout(() => editorBus.reveal(first.line, first.col || 1), 120));
    }
  }, [problems]);

  const options = useMemo(
    () => ({
      fontSize,
      fontFamily: '"JetBrains Mono","Cascadia Code",ui-monospace,Menlo,Consolas,monospace',
      fontLigatures: false,
      minimap: { enabled: !mobile },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      tabSize: active && monacoLanguage(active) === "javascript" ? 2 : 4,
      insertSpaces: true,
      wordWrap: mobile ? ("on" as const) : ("off" as const),
      renderWhitespace: "selection" as const,
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: false },
      lineNumbersMinChars: mobile ? 3 : 4,
      glyphMargin: !mobile,
      folding: !mobile,
      padding: { top: 8, bottom: 8 },
      smoothScrolling: false,
      cursorBlinking: "smooth" as const,
      suggestOnTriggerCharacters: true,
      quickSuggestions: { other: true, comments: false, strings: true },
      acceptSuggestionOnEnter: "on" as const,
      fixedOverflowWidgets: true,
      mouseWheelZoom: true,
      accessibilitySupport: "auto" as const,
      find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: "selection" as const },
      contextmenu: !mobile,
    }),
    [fontSize, mobile, active],
  );

  if (!project) return null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-bg">
      <div role="tablist" className="flex h-8 shrink-0 overflow-x-auto border-b border-line bg-panel">
        {tabs.map((p) => {
          const b = buffers[p];
          const dirty = b && b.content !== b.saved;
          const hasErr = problems.some((x) => x.file === p && x.severity === "error");
          return (
            <div key={p} role="tab" aria-selected={p === active} data-active={p === active} className="tab group cursor-pointer" onClick={() => setActive(p)} onAuxClick={(e) => e.button === 1 && closeTab(p)} title={p}>
              <span className={`max-w-[160px] truncate ${hasErr ? "text-err" : ""}`}>{basename(p)}</span>
              <button
                className="flex h-4 w-4 items-center justify-center rounded text-dim hover:bg-line hover:text-fg"
                aria-label={`Close ${basename(p)}`}
                onClick={(e) => (e.stopPropagation(), closeTab(p))}
              >
                {dirty ? <span className="h-1.5 w-1.5 rounded-full bg-warn group-hover:hidden" /> : null}
                <X size={11} className={dirty ? "hidden group-hover:block" : ""} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="relative min-h-0 flex-1">
        {!active ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-dim">
            <p className="text-[13px]">No file open</p>
            <p className="text-[12px]">Select a file in the Files panel or create a new one.</p>
          </div>
        ) : buf?.loading ? (
          <div className="flex h-full items-center justify-center text-dim">
            <Loader2 className="animate-spin" size={18} />
          </div>
        ) : buf?.error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-dim">
            <FileWarning size={22} />
            <p className="max-w-sm text-center text-[12px]">{buf.error}</p>
          </div>
        ) : buf?.binary ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-dim">
            <FileWarning size={22} />
            <p className="text-[12px]">{basename(active)} is a binary file and cannot be edited here.</p>
          </div>
        ) : (
          <Editor
            key={project.id}
            path={uriFor(project.id, active)}
            language={monacoLanguage(active)}
            value={buf?.content ?? ""}
            theme={theme === "dark" ? "compieler-dark" : "compieler-light"}
            options={options}
            loading={<Loader2 className="animate-spin text-dim" size={18} />}
            onChange={(v) => edit(active, v ?? "")}
            onMount={(editor, m) => {
              editorBus.set(editor, m);
              editor.onDidChangeCursorPosition((e) => setCursor(e.position.lineNumber, e.position.column));
              const pos = editor.getPosition();
              if (pos) setCursor(pos.lineNumber, pos.column);
              editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => void useRun.getState().run());
              editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => void useProject.getState().saveAll());
              editor.addCommand(m.KeyMod.Shift | m.KeyMod.Alt | m.KeyCode.KeyF, () => void useProject.getState().formatActive());
            }}
          />
        )}
      </div>
    </div>
  );
}
