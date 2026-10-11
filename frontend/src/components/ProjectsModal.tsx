import { Download, FolderPlus, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import type { Language } from "../api/types";
import { useProject } from "../store/project";
import { useUI } from "../store/ui";
import { Modal } from "./Dialogs";

const LANG_LABEL: Record<Language, string> = { python: "Python", cpp: "C++", javascript: "JavaScript" };

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function ProjectsModal() {
  const close = () => useUI.getState().openModal(null);
  const projects = useProject((s) => s.projects);
  const current = useProject((s) => s.project);
  const [name, setName] = useState("");
  const [lang, setLang] = useState<Language>("python");
  const [busy, setBusy] = useState(false);
  const zip = useRef<HTMLInputElement>(null);
  const store = useProject.getState();

  return (
    <Modal title="Projects" onClose={close} width={560}>
      <form
        className="flex flex-wrap items-center gap-2 border-b border-line p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await store.createProject(name.trim() || "Untitled", lang);
          setBusy(false);
          close();
        }}
      >
        <input className="field !h-8 min-w-[140px] flex-1" placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-label="New project name" />
        <select className="field !h-8 !w-auto" value={lang} onChange={(e) => setLang(e.target.value as Language)} aria-label="Language">
          {(Object.keys(LANG_LABEL) as Language[]).map((l) => (
            <option key={l} value={l}>
              {LANG_LABEL[l]}
            </option>
          ))}
        </select>
        <button className="btn btn-solid !h-8" disabled={busy}>
          <FolderPlus size={14} /> Create
        </button>
      </form>
      <div className="flex gap-2 border-b border-line px-3 py-2">
        <button className="btn btn-solid" onClick={() => zip.current?.click()}>
          <Upload size={13} /> Import ZIP
        </button>
        <button className="btn btn-solid" onClick={() => void store.exportZip()} disabled={!current}>
          <Download size={13} /> Export current as ZIP
        </button>
        <input
          ref={zip}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) {
              await store.importZip(f);
              close();
            }
          }}
        />
      </div>
      <div className="px-3 pb-1 pt-2 text-[11px] uppercase tracking-wide text-dim">Recent projects</div>
      <ul className="pb-2">
        {projects.map((p) => (
          <li key={p.id} className={`group flex items-center gap-2 px-3 py-1.5 ${p.id === current?.id ? "bg-accent/10" : "hover:bg-raised"}`}>
            <button
              className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
              onClick={async () => {
                if (p.id !== current?.id) await store.openProject(p.id);
                close();
              }}
            >
              <span className="truncate text-[13px] font-medium">{p.name}</span>
              <span className="shrink-0 rounded bg-raised px-1.5 py-px text-[10.5px] text-dim">{LANG_LABEL[p.language]}</span>
              <span className="ml-auto shrink-0 text-[11px] text-dim">{ago(p.last_opened_at)}</span>
            </button>
            <button
              className="btn !h-6 !px-1.5 text-dim hover:!text-err"
              aria-label={`Delete ${p.name}`}
              onClick={async () => {
                const ok = await useUI.getState().confirm({ title: "Delete project", message: `Delete "${p.name}" and all its files? This cannot be undone.`, danger: true, confirmText: "Delete" });
                if (ok) await store.deleteProject(p.id);
              }}
            >
              <Trash2 size={13} />
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
