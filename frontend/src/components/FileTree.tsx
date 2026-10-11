import { ChevronDown, ChevronRight, FilePlus, FileText, Folder, FolderOpen, FolderPlus, Pencil, RefreshCw, Trash2, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { basename, buildTree, dirname, join, type TreeNode } from "../lib/paths";
import { useProject } from "../store/project";
import { useUI } from "../store/ui";

const EXT_COLOR: Record<string, string> = {
  py: "text-sky-400",
  cpp: "text-blue-400",
  cc: "text-blue-400",
  h: "text-violet-400",
  hpp: "text-violet-400",
  js: "text-yellow-400",
  mjs: "text-yellow-400",
  json: "text-amber-300",
  txt: "text-dim",
  md: "text-dim",
};

export function FileTree() {
  const tree = useProject((s) => s.tree);
  const active = useProject((s) => s.active);
  const buffers = useProject((s) => s.buffers);
  const { openFile, createFile, createDir, renameEntry, deleteEntry, refreshTree, upload } = useProject.getState();
  const setMobileView = useUI((s) => s.setMobileView);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<{ path: string; type: "file" | "dir" } | null>(null);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const nodes = useMemo(() => buildTree(tree), [tree]);

  const targetDir = () => (selected ? (selected.type === "dir" ? selected.path : dirname(selected.path)) : "");

  async function newFile() {
    const name = await useUI.getState().prompt({ title: "New file", label: `Name${targetDir() ? ` (in ${targetDir()}/)` : ""}`, confirmText: "Create" });
    if (name) {
      await createFile(join(targetDir(), name));
      setMobileView("editor");
    }
  }
  async function newFolder() {
    const name = await useUI.getState().prompt({ title: "New folder", label: "Folder name", confirmText: "Create" });
    if (name) await createDir(join(targetDir(), name));
  }
  async function rename(path: string) {
    const name = await useUI.getState().prompt({ title: "Rename", initial: basename(path), confirmText: "Rename", label: "New name" });
    if (name && name !== basename(path)) await renameEntry(path, join(dirname(path), name));
  }
  async function remove(path: string, type: "file" | "dir") {
    const ok = await useUI.getState().confirm({
      title: `Delete ${type === "dir" ? "folder" : "file"}`,
      message: `Delete "${path}"${type === "dir" ? " and everything in it" : ""}? This cannot be undone.`,
      danger: true,
      confirmText: "Delete",
    });
    if (ok) await deleteEntry(path);
  }

  const row = (n: TreeNode, depth: number): React.ReactNode => {
    const isDir = n.type === "dir";
    const open = isDir && !collapsed.has(n.path);
    const isSel = selected?.path === n.path;
    const isActive = !isDir && active === n.path;
    const dirty = !isDir && buffers[n.path] && buffers[n.path].content !== buffers[n.path].saved;
    const ext = n.name.includes(".") ? n.name.split(".").pop()!.toLowerCase() : "";
    return (
      <div key={n.path}>
        <div
          role="treeitem"
          aria-selected={isSel || isActive}
          aria-expanded={isDir ? open : undefined}
          tabIndex={0}
          className={`group flex h-[26px] cursor-pointer items-center gap-1 pr-1 text-[12.5px] ${isActive ? "bg-accent/15" : isSel ? "bg-raised" : "hover:bg-raised/60"}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => {
            setSelected({ path: n.path, type: n.type });
            if (isDir)
              setCollapsed((c) => {
                const next = new Set(c);
                next.has(n.path) ? next.delete(n.path) : next.add(n.path);
                return next;
              });
            else {
              void openFile(n.path);
              setMobileView("editor");
            }
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).click()}
        >
          {isDir ? (open ? <ChevronDown size={13} className="shrink-0 text-dim" /> : <ChevronRight size={13} className="shrink-0 text-dim" />) : <span className="w-[13px] shrink-0" />}
          {isDir ? open ? <FolderOpen size={14} className="shrink-0 text-amber-300/80" /> : <Folder size={14} className="shrink-0 text-amber-300/80" /> : <FileText size={14} className={`shrink-0 ${EXT_COLOR[ext] ?? "text-dim"}`} />}
          <span className="min-w-0 flex-1 truncate">{n.name}</span>
          {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="Unsaved changes" />}
          <span className={`${isSel ? "flex" : "hidden group-hover:flex"} shrink-0 items-center`}>
            <button className="btn !h-5 !px-1" title="Rename" aria-label={`Rename ${n.name}`} onClick={(e) => (e.stopPropagation(), void rename(n.path))}>
              <Pencil size={12} />
            </button>
            <button className="btn !h-5 !px-1 hover:!text-err" title="Delete" aria-label={`Delete ${n.name}`} onClick={(e) => (e.stopPropagation(), void remove(n.path, n.type))}>
              <Trash2 size={12} />
            </button>
          </span>
        </div>
        {isDir && open && n.children.map((c) => row(c, depth + 1))}
      </div>
    );
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onDragOver={(e) => (e.preventDefault(), setDropping(true))}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        if (e.dataTransfer.files.length) void upload(e.dataTransfer.files, targetDir());
      }}
    >
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-line px-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-dim">Files</span>
        <div className="flex items-center">
          <button className="btn !h-6 !px-1.5" title="New file" aria-label="New file" onClick={() => void newFile()}>
            <FilePlus size={14} />
          </button>
          <button className="btn !h-6 !px-1.5" title="New folder" aria-label="New folder" onClick={() => void newFolder()}>
            <FolderPlus size={14} />
          </button>
          <button className="btn !h-6 !px-1.5" title="Upload files" aria-label="Upload files" onClick={() => fileInput.current?.click()}>
            <Upload size={14} />
          </button>
          <button className="btn !h-6 !px-1.5" title="Refresh" aria-label="Refresh file list" onClick={() => void refreshTree()}>
            <RefreshCw size={13} />
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => (e.target.files && void upload(e.target.files, targetDir()), (e.target.value = ""))} />
        </div>
      </div>
      <div role="tree" className={`min-h-0 flex-1 overflow-auto py-1 ${dropping ? "bg-accent/10 outline outline-1 -outline-offset-2 outline-accent/50" : ""}`} onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
        {nodes.length === 0 ? <p className="px-3 py-4 text-[12px] text-dim">This project is empty. Create a file with the + button, or drop files here.</p> : nodes.map((n) => row(n, 0))}
      </div>
    </div>
  );
}
