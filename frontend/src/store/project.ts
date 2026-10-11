import { create } from "zustand";
import { api, ApiError, getToken, setToken } from "../api/client";
import type { Language, Project, ProjectSettings, ServerConfig, TreeEntry, User } from "../api/types";
import { editorBus } from "../lib/editorBus";
import { basename, join, monacoLanguage } from "../lib/paths";
import { lsGet, lsSet } from "../lib/storage";
import { useUI } from "./ui";

export interface Buffer {
  content: string;
  saved: string;
  binary: boolean;
  loading: boolean;
  error?: string;
}
export type SaveStatus = "saved" | "saving" | "dirty" | "error";

interface ProjectState {
  ready: boolean;
  bootError: string | null;
  user: User | null;
  config: ServerConfig | null;
  project: Project | null;
  projects: Project[];
  tree: TreeEntry[];
  tabs: string[];
  active: string | null;
  buffers: Record<string, Buffer>;
  saveStatus: SaveStatus;

  bootstrap: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  openProject: (id: number) => Promise<void>;
  createProject: (name: string, language: Language) => Promise<void>;
  deleteProject: (id: number) => Promise<void>;
  renameProject: (name: string) => Promise<void>;
  setLanguage: (language: Language) => Promise<void>;
  setSettings: (patch: ProjectSettings) => Promise<void>;
  importZip: (file: File) => Promise<void>;
  exportZip: () => Promise<void>;

  refreshTree: () => Promise<void>;
  openFile: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  setActive: (path: string) => void;
  edit: (path: string, content: string) => void;
  saveAll: () => Promise<void>;
  reloadCleanBuffers: () => Promise<void>;
  createFile: (path: string) => Promise<void>;
  createDir: (path: string) => Promise<void>;
  renameEntry: (src: string, dst: string) => Promise<void>;
  deleteEntry: (path: string) => Promise<void>;
  upload: (files: FileList | File[], dir?: string) => Promise<void>;
  formatActive: () => Promise<void>;

  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const saveTimers = new Map<string, number>();
let saveErrorShown = false;
const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

function persistTabs(s: ProjectState) {
  if (!s.project) return;
  lsSet(`compieler.tabs.${s.project.id}`, JSON.stringify({ tabs: s.tabs, active: s.active }));
}

export const useProject = create<ProjectState>((set, get) => {
  const toast = (t: string, kind: "info" | "error" | "ok" = "info") => useUI.getState().toast(t, kind);
  const pid = () => get().project?.id ?? 0;
  const computeStatus = (buffers: Record<string, Buffer>, current: SaveStatus): SaveStatus => {
    if (current === "error") return "error";
    return Object.values(buffers).some((b) => b.content !== b.saved) ? "dirty" : "saved";
  };

  async function saveOne(path: string) {
    const b = get().buffers[path];
    if (!b || b.binary || b.content === b.saved) return;
    const sent = b.content;
    set({ saveStatus: "saving" });
    try {
      await api.writeFile(pid(), path, sent);
      saveErrorShown = false;
      set((s) => {
        const cur = s.buffers[path];
        if (!cur) return {};
        const buffers = { ...s.buffers, [path]: { ...cur, saved: sent } };
        return { buffers, saveStatus: computeStatus(buffers, "saved") };
      });
    } catch (e) {
      set({ saveStatus: "error" });
      if (!saveErrorShown) {
        saveErrorShown = true;
        toast(`Could not save ${basename(path)}: ${errText(e)}`, "error");
      }
      throw e;
    }
  }

  async function loadTabs(project: Project, tree: TreeEntry[]) {
    let tabs: string[] = [];
    let active: string | null = null;
    try {
      const saved = JSON.parse(lsGet(`compieler.tabs.${project.id}`) ?? "null");
      if (saved && Array.isArray(saved.tabs)) {
        const existing = new Set(tree.filter((e) => e.type === "file").map((e) => e.path));
        tabs = saved.tabs.filter((p: string) => existing.has(p));
        active = tabs.includes(saved.active) ? saved.active : tabs[0] ?? null;
      }
    } catch {
      /* corrupted - fall through */
    }
    if (!tabs.length) {
      const entry = project.settings.entry;
      const files = tree.filter((e) => e.type === "file");
      const first = (entry && files.find((f) => f.path === entry)?.path) ?? files[0]?.path ?? null;
      if (first) {
        tabs = [first];
        active = first;
      }
    }
    set({ tabs, active, buffers: {} });
    await Promise.all(tabs.map((p) => get().openFile(p)));
    set({ active });
  }

  return {
    ready: false,
    bootError: null,
    user: null,
    config: null,
    project: null,
    projects: [],
    tree: [],
    tabs: [],
    active: null,
    buffers: {},
    saveStatus: "saved",

    // ------------------------------------------------------------ boot / auth
    async bootstrap() {
      try {
        api.config().then((config) => set({ config })).catch(() => undefined);
        let user: User | null = null;
        if (getToken()) {
          try {
            user = await api.me();
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 401)) throw e;
            setToken(null);
          }
        }
        if (!user) {
          const g = await api.guest();
          setToken(g.token);
          user = g.user;
        }
        set({ user });
        let projects = await api.projects();
        const last = Number(lsGet("compieler.lastProject"));
        let target = projects.find((p) => p.id === last) ?? projects[0];
        if (!target) {
          target = await api.createProject("My first project", "python");
          projects = [target];
        }
        set({ projects });
        await get().openProject(target.id);
        set({ ready: true, bootError: null });
      } catch (e) {
        set({ bootError: errText(e), ready: false });
      }
    },

    async refreshProjects() {
      try {
        set({ projects: await api.projects() });
      } catch (e) {
        toast(errText(e), "error");
      }
    },

    async login(email, password) {
      const r = await api.login(email, password);
      setToken(r.token);
      set({ user: r.user });
      lsSet("compieler.lastProject", "");
      await get().bootstrap();
      toast(`Signed in as ${r.user.email}`, "ok");
    },
    async register(email, password) {
      const r = await api.register(email, password);
      setToken(r.token);
      set({ user: r.user });
      toast("Account created - your projects are saved to it", "ok");
    },
    async logout() {
      await get().saveAll().catch(() => undefined);
      setToken(null);
      lsSet("compieler.lastProject", "");
      set({ ready: false, project: null, user: null });
      await get().bootstrap();
    },

    // ------------------------------------------------------------ projects
    async openProject(id) {
      await get().saveAll().catch(() => undefined);
      const project = await api.getProject(id);
      const tree = await api.tree(id);
      lsSet("compieler.lastProject", String(id));
      set({ project, tree, tabs: [], active: null, buffers: {}, saveStatus: "saved" });
      await loadTabs(project, tree);
      void get().refreshProjects();
    },
    async createProject(name, language) {
      try {
        const p = await api.createProject(name, language);
        await get().openProject(p.id);
      } catch (e) {
        toast(errText(e), "error");
      }
    },
    async deleteProject(id) {
      try {
        await api.deleteProject(id);
        localStorage.removeItem(`compieler.tabs.${id}`);
      } catch (e) {
        toast(errText(e), "error");
        return;
      }
      const rest = (await api.projects()).filter((p) => p.id !== id);
      set({ projects: rest });
      if (get().project?.id === id) {
        if (rest.length) await get().openProject(rest[0].id);
        else await get().createProject("My first project", "python");
      }
    },
    async renameProject(name) {
      const p = get().project;
      if (!p || !name.trim() || name === p.name) return;
      try {
        set({ project: await api.patchProject(p.id, { name: name.trim() }) });
        void get().refreshProjects();
      } catch (e) {
        toast(errText(e), "error");
      }
    },
    async setLanguage(language) {
      const p = get().project;
      if (!p || p.language === language) return;
      try {
        await get().saveAll();
        const project = await api.patchProject(p.id, { language });
        const tree = await api.tree(p.id);
        set({ project, tree });
        const entry = project.settings.entry;
        if (entry) await get().openFile(entry);
      } catch (e) {
        toast(errText(e), "error");
      }
    },
    async setSettings(patch) {
      const p = get().project;
      if (!p) return;
      try {
        set({ project: await api.patchProject(p.id, { settings: patch }) });
      } catch (e) {
        toast(errText(e), "error");
      }
    },
    async importZip(file) {
      try {
        const p = await api.importZip(file, file.name.replace(/\.zip$/i, ""));
        await get().openProject(p.id);
        toast(`Imported ${p.name}`, "ok");
      } catch (e) {
        toast(`Import failed: ${errText(e)}`, "error");
      }
    },
    async exportZip() {
      const p = get().project;
      if (!p) return;
      try {
        await get().saveAll();
        await api.exportZip(p.id, p.name);
      } catch (e) {
        toast(`Export failed: ${errText(e)}`, "error");
      }
    },

    // ------------------------------------------------------------ files
    async refreshTree() {
      if (!get().project) return;
      try {
        set({ tree: await api.tree(pid()) });
      } catch (e) {
        toast(errText(e), "error");
      }
    },

    async openFile(path) {
      const s = get();
      if (!s.tabs.includes(path)) set({ tabs: [...s.tabs, path] });
      set({ active: path });
      persistTabs(get());
      if (get().buffers[path] && !get().buffers[path].error) return;
      set((st) => ({ buffers: { ...st.buffers, [path]: { content: "", saved: "", binary: false, loading: true } } }));
      try {
        const f = await api.readFile(pid(), path);
        set((st) => ({
          buffers: { ...st.buffers, [path]: { content: f.content, saved: f.content, binary: f.binary, loading: false } },
        }));
      } catch (e) {
        set((st) => ({
          buffers: { ...st.buffers, [path]: { content: "", saved: "", binary: false, loading: false, error: errText(e) } },
        }));
      }
    },
    closeTab(path) {
      const b = get().buffers[path];
      if (b && b.content !== b.saved) void saveOne(path).catch(() => undefined);
      set((s) => {
        const idx = s.tabs.indexOf(path);
        const tabs = s.tabs.filter((t) => t !== path);
        const active = s.active === path ? tabs[Math.min(idx, tabs.length - 1)] ?? null : s.active;
        const buffers = { ...s.buffers };
        delete buffers[path];
        return { tabs, active, buffers };
      });
      persistTabs(get());
    },
    setActive(path) {
      set({ active: path });
      persistTabs(get());
    },
    edit(path, content) {
      const b = get().buffers[path];
      if (!b || b.content === content) return;
      set((s) => ({
        buffers: { ...s.buffers, [path]: { ...b, content } },
        saveStatus: s.saveStatus === "error" ? "error" : "dirty",
      }));
      window.clearTimeout(saveTimers.get(path));
      saveTimers.set(
        path,
        window.setTimeout(() => {
          saveTimers.delete(path);
          void saveOne(path).catch(() => undefined);
        }, 900),
      );
    },
    async saveAll() {
      for (const t of saveTimers.values()) window.clearTimeout(t);
      saveTimers.clear();
      const dirty = Object.entries(get().buffers).filter(([, b]) => !b.binary && b.content !== b.saved);
      if (!dirty.length) {
        if (get().saveStatus === "error") set({ saveStatus: "saved" });
        return;
      }
      set((s) => ({ saveStatus: s.saveStatus === "error" ? "dirty" : s.saveStatus }));
      await Promise.all(dirty.map(([p]) => saveOne(p)));
    },
    /** After a program ran it may have rewritten files; refresh tabs that have no unsaved edits. */
    async reloadCleanBuffers() {
      await get().refreshTree();
      const entries = Object.entries(get().buffers).filter(([, b]) => !b.binary && b.content === b.saved && !b.loading);
      await Promise.all(
        entries.map(async ([path, b]) => {
          try {
            const f = await api.readFile(pid(), path);
            const cur = get().buffers[path];
            if (f.content !== b.saved && cur && cur.content === b.saved) {
              set((s) => ({ buffers: { ...s.buffers, [path]: { ...cur, content: f.content, saved: f.content, binary: f.binary } } }));
            }
          } catch {
            /* file may have been deleted by the program */
          }
        }),
      );
    },
    async createFile(path) {
      try {
        await api.writeFile(pid(), path, "");
        await get().refreshTree();
        await get().openFile(path);
      } catch (e) {
        toast(errText(e), "error");
      }
    },
    async createDir(path) {
      try {
        await api.mkdir(pid(), path);
        await get().refreshTree();
      } catch (e) {
        toast(errText(e), "error");
      }
    },
    async renameEntry(src, dst) {
      if (src === dst) return;
      try {
        await get().saveAll();
        await api.move(pid(), src, dst);
        const remap = (p: string) => (p === src ? dst : p.startsWith(src + "/") ? dst + p.slice(src.length) : p);
        set((s) => {
          const buffers: Record<string, Buffer> = {};
          for (const [k, v] of Object.entries(s.buffers)) buffers[remap(k)] = v;
          return { tabs: s.tabs.map(remap), active: s.active ? remap(s.active) : null, buffers };
        });
        persistTabs(get());
        await get().refreshTree();
        set({ project: await api.getProject(pid()) });
      } catch (e) {
        toast(errText(e), "error");
      }
    },
    async deleteEntry(path) {
      try {
        await api.deleteFile(pid(), path);
        for (const t of get().tabs) if (t === path || t.startsWith(path + "/")) get().closeTab(t);
        await get().refreshTree();
      } catch (e) {
        toast(errText(e), "error");
      }
    },
    async upload(files, dir = "") {
      let ok = 0;
      for (const f of Array.from(files)) {
        try {
          await api.upload(pid(), f, join(dir, f.name));
          ok++;
        } catch (e) {
          toast(`${f.name}: ${errText(e)}`, "error");
        }
      }
      if (ok) {
        await get().refreshTree();
        toast(`Uploaded ${ok} file${ok > 1 ? "s" : ""}`, "ok");
      }
    },

    async formatActive() {
      const { active, buffers, project } = get();
      if (!active || !project) return;
      const b = buffers[active];
      if (!b || b.binary) return;
      const lang = monacoLanguage(active);
      if (lang !== "python" && lang !== "cpp" && lang !== "javascript") {
        toast("Formatting is available for Python, C++ and JavaScript files", "info");
        return;
      }
      try {
        const r = await api.format(lang as Language, b.content, basename(active));
        if (r.content !== b.content && !editorBus.replaceAll(r.content)) get().edit(active, r.content);
        toast("Formatted", "ok");
      } catch (e) {
        toast(errText(e), "error");
      }
    },
  };
});

