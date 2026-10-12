/** On-device implementation of the REST API (the standalone/APK build): IndexedDB instead of a backend. */
import JSZip from "jszip";
import { saveBlob } from "../lib/download";
import { db, type FileRow, type ProjectRow } from "../runtime/db";
import { DEFAULT_ENTRY, TEMPLATES, detectLanguage } from "../runtime/templates";
import { ApiError } from "./errors";
import type { Language, Project, ProjectSettings, ServerConfig, TreeEntry, User } from "./types";

const RESERVED = new Set([".venv", "node_modules", ".compieler", "__pycache__"]);
const MAX_FILE = 2 * 1024 * 1024;
const MAX_PROJECT = 50 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_PROJECTS = 100;

const USER: User = { id: 1, email: null, name: "This device", is_guest: true };
const enc = new TextEncoder();
const iso = () => new Date().toISOString();

export function splitPath(rel: string, allowReserved = false): string[] {
  if (typeof rel !== "string" || !rel) throw new ApiError(400, "Path is empty");
  if (rel.length > 400) throw new ApiError(400, "Path is too long");
  if (rel.includes("\0") || rel.includes("\\")) throw new ApiError(400, "Path contains illegal characters");
  if (rel.startsWith("/")) throw new ApiError(400, "Absolute paths are not allowed");
  const parts = rel.split("/");
  if (parts[parts.length - 1] === "") parts.pop();
  if (!parts.length || parts.length > 24) throw new ApiError(400, "Invalid path");
  for (const p of parts) {
    if (p === "" || p === "." || p === ".." || p.length > 200) throw new ApiError(400, "Invalid path component");
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(p)) throw new ApiError(400, "Path contains control characters");
    if (!allowReserved && RESERVED.has(p)) throw new ApiError(400, `'${p}' is managed by the runtime and cannot be edited directly`);
  }
  return parts;
}

const toProject = (p: ProjectRow): Project => p as unknown as Project;

async function requireProject(id: number): Promise<ProjectRow> {
  const p = await db.getProject(id);
  if (!p) throw new ApiError(404, "Project not found");
  return p;
}
const touch = async (p: ProjectRow) => {
  p.updated_at = iso();
  await db.putProject(p);
};

async function writeRow(pid: number, path: string, data: Uint8Array) {
  const parts = splitPath(path);
  const now = Date.now();
  const rows: FileRow[] = [];
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    const ex = await db.getFile(pid, dir);
    if (ex && ex.kind === "file") throw new ApiError(409, "A file with this name already exists");
    if (!ex) rows.push({ pid, path: dir, kind: "dir", data: new Uint8Array(0), size: 0, mtime: now });
  }
  const norm = parts.join("/");
  const existing = await db.getFile(pid, norm);
  if (existing?.kind === "dir") throw new ApiError(409, "A directory with this name already exists");
  rows.push({ pid, path: norm, kind: "file", data, size: data.length, mtime: now });
  await db.putFiles(rows);
}

async function checkQuota(pid: number, path: string, size: number) {
  const files = await db.files(pid);
  const files_ = files.filter((f) => f.kind === "file");
  const existing = files.find((f) => f.path === path);
  if (!existing && files.length >= MAX_FILES) throw new ApiError(413, `Too many files (limit ${MAX_FILES})`);
  const total = files_.reduce((a, f) => a + f.size, 0) - (existing?.size ?? 0) + size;
  if (total > MAX_PROJECT) throw new ApiError(413, "Project size limit exceeded");
}

async function seed(pid: number, language: Language) {
  for (const [path, content] of Object.entries(TEMPLATES[language])) await writeRow(pid, path, enc.encode(content));
}

async function createProject(name: string, language: Language, template = true): Promise<Project> {
  if ((await db.listProjects()).length >= MAX_PROJECTS) throw new ApiError(409, "Project limit reached - delete an old project first");
  const now = iso();
  const p = await db.putProject({ name: name.trim() || "Untitled", language, settings: {}, created_at: now, updated_at: now, last_opened_at: now });
  if (template) {
    await seed(p.id, language);
    p.settings = { entry: DEFAULT_ENTRY[language] };
    await db.putProject(p);
  }
  return toProject(p);
}

export const localApi = {
  async config(): Promise<ServerConfig> {
    return {
      languages: ["python", "cpp", "javascript"],
      cpp_standards: ["c++11", "c++14", "c++17", "c++20"],
      formatters: { python: false, cpp: false, javascript: false },
      limits: { run_wall_seconds: 60, run_cpu_seconds: 60, memory_mb: 1024, max_output_bytes: 2_000_000, max_upload_bytes: 25 * 1024 * 1024 },
      allow_runtime_network: false,
      allow_registration: false,
      sandbox: { backend: "on-device", isolation: "WebAssembly" },
    } as ServerConfig;
  },
  async guest() {
    return { token: "local", user: USER };
  },
  async me() {
    return USER;
  },
  async register(): Promise<{ token: string; user: User }> {
    throw new ApiError(400, "Accounts are not available in the offline app - your projects are stored on this device.");
  },
  async login(): Promise<{ token: string; user: User }> {
    throw new ApiError(400, "Accounts are not available in the offline app - your projects are stored on this device.");
  },

  async projects(): Promise<Project[]> {
    return (await db.listProjects()).sort((a, b) => b.last_opened_at.localeCompare(a.last_opened_at)).map(toProject);
  },
  createProject: (name: string, language: Language) => createProject(name, language),
  async getProject(id: number): Promise<Project> {
    const p = await requireProject(id);
    p.last_opened_at = iso();
    await db.putProject(p);
    return toProject(p);
  },
  async patchProject(id: number, patch: { name?: string; language?: Language; settings?: ProjectSettings }): Promise<Project> {
    const p = await requireProject(id);
    if (patch.name !== undefined && patch.name.trim()) p.name = patch.name.trim();
    if (patch.language && patch.language !== p.language) {
      p.language = patch.language;
      let entry = DEFAULT_ENTRY[patch.language];
      const files = (await db.files(id)).filter((f) => f.kind === "file");
      if (!files.some((f) => f.path === entry)) {
        const exts = { python: [".py"], cpp: [".cpp", ".cc", ".cxx"], javascript: [".js"] }[patch.language];
        const existing = files.find((f) => exts.some((e) => f.path.endsWith(e)));
        if (existing) entry = existing.path;
        else for (const [path, content] of Object.entries(TEMPLATES[patch.language])) if (!files.some((f) => f.path === path)) await writeRow(id, path, enc.encode(content));
      }
      p.settings = { ...p.settings, entry };
    }
    if (patch.settings) {
      const merged: Record<string, unknown> = { ...p.settings, ...patch.settings };
      if (typeof merged.entry === "string" && merged.entry) merged.entry = splitPath(merged.entry).join("/");
      for (const k of Object.keys(merged)) if (merged[k] === null || merged[k] === "" || merged[k] === undefined) delete merged[k];
      p.settings = merged;
    }
    await touch(p);
    return toProject(p);
  },
  async deleteProject(id: number) {
    await requireProject(id);
    await db.deleteProject(id);
  },

  async importZip(file: File, name?: string): Promise<Project> {
    if (file.size > 25 * 1024 * 1024) throw new ApiError(413, "Archive is too large");
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(await file.arrayBuffer());
    } catch {
      throw new ApiError(400, "This is not a valid ZIP archive");
    }
    const entries: [string, Uint8Array][] = [];
    let total = 0;
    for (const [rawName, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      let parts: string[];
      try {
        parts = splitPath(rawName.replace(/\\/g, "/"), true);
      } catch {
        continue;
      }
      if (parts.some((s) => RESERVED.has(s) || s === ".git")) continue;
      const data = await entry.async("uint8array");
      total += data.length;
      if (total > MAX_PROJECT || entries.length >= MAX_FILES) throw new ApiError(413, "Archive exceeds the project size limits");
      entries.push([parts.join("/"), data]);
    }
    if (!entries.length) throw new ApiError(400, "The archive contains no usable files");
    const language = detectLanguage(entries.map((e) => e[0]));
    const p = await createProject(name || file.name.replace(/\.zip$/i, "") || "Imported", language, false);
    for (const [path, data] of entries) await writeRow(p.id, path, data);
    const names = new Set(entries.map((e) => e[0]));
    let entry = DEFAULT_ENTRY[language];
    if (!names.has(entry)) {
      const ext = { python: ".py", cpp: ".cpp", javascript: ".js" }[language];
      entry = [...names].sort().find((n) => n.endsWith(ext)) ?? entry;
    }
    return localApi.patchProject(p.id, { settings: { entry } });
  },
  async exportZip(id: number, name: string) {
    const files = await db.files(id);
    const zip = new JSZip();
    for (const f of files) {
      if (f.path.split("/").some((s) => RESERVED.has(s))) continue;
      if (f.kind === "dir") zip.folder(f.path);
      else zip.file(f.path, f.data);
    }
    await saveBlob(await zip.generateAsync({ type: "blob", compression: "DEFLATE" }), `${name.replace(/[^\w.-]+/g, "_") || "project"}.zip`);
  },

  async tree(id: number): Promise<TreeEntry[]> {
    await requireProject(id);
    const rows = await db.files(id);
    const out = new Map<string, TreeEntry>();
    for (const r of rows) {
      if (r.path.split("/").some((s) => RESERVED.has(s))) continue;
      out.set(r.path, { path: r.path, type: r.kind, size: r.kind === "file" ? r.size : 0 });
      const parts = r.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join("/");
        if (!out.has(d)) out.set(d, { path: d, type: "dir", size: 0 });
      }
    }
    return [...out.values()];
  },
  async readFile(id: number, path: string) {
    const norm = splitPath(path).join("/");
    const row = await db.getFile(id, norm);
    if (!row || row.kind !== "file") throw new ApiError(404, "File not found");
    if (row.size > MAX_FILE) throw new ApiError(413, "File is too large to open in the editor");
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(row.data);
      if (text.includes("\0")) throw new Error("binary");
      return { path: norm, binary: false, size: row.size, content: text };
    } catch {
      return { path: norm, binary: true, size: row.size, content: "" };
    }
  },
  /** Raw bytes (image preview). */
  async readBytes(id: number, path: string): Promise<Uint8Array | null> {
    const row = await db.getFile(id, splitPath(path).join("/"));
    return row?.kind === "file" ? row.data : null;
  },
  async writeFile(id: number, path: string, content: string) {
    const p = await requireProject(id);
    const data = enc.encode(content);
    if (data.length > MAX_FILE) throw new ApiError(413, "File is too large");
    const norm = splitPath(path).join("/");
    await checkQuota(id, norm, data.length);
    await writeRow(id, norm, data);
    await touch(p);
  },
  async upload(id: number, file: File, path: string) {
    const p = await requireProject(id);
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length > 25 * 1024 * 1024) throw new ApiError(413, "File is too large");
    const norm = splitPath(path).join("/");
    await checkQuota(id, norm, data.length);
    await writeRow(id, norm, data);
    await touch(p);
  },
  async mkdir(id: number, path: string) {
    const p = await requireProject(id);
    const parts = splitPath(path);
    const rows: FileRow[] = [];
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      const ex = await db.getFile(id, d);
      if (ex?.kind === "file") throw new ApiError(409, "A file with this name already exists");
      if (!ex) rows.push({ pid: id, path: d, kind: "dir", data: new Uint8Array(0), size: 0, mtime: Date.now() });
    }
    await db.putFiles(rows);
    await touch(p);
  },
  async move(id: number, src: string, dst: string) {
    const p = await requireProject(id);
    const s = splitPath(src).join("/");
    const d = splitPath(dst).join("/");
    if (d === s || d.startsWith(s + "/")) throw new ApiError(400, "Cannot move a folder into itself");
    const rows = await db.files(id);
    const moving = rows.filter((r) => r.path === s || r.path.startsWith(s + "/"));
    if (!moving.length) throw new ApiError(404, "Not found");
    if (rows.some((r) => r.path === d)) throw new ApiError(409, "Destination already exists");
    await db.deleteFiles(id, moving.map((r) => r.path));
    await db.putFiles(moving.map((r) => ({ ...r, path: d + r.path.slice(s.length) })));
    for (const dir of d.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/")))
      if (!rows.some((r) => r.path === dir)) await db.putFiles([{ pid: id, path: dir, kind: "dir", data: new Uint8Array(0), size: 0, mtime: Date.now() }]);
    const entry = p.settings.entry;
    if (typeof entry === "string" && (entry === s || entry.startsWith(s + "/"))) p.settings = { ...p.settings, entry: d + entry.slice(s.length) };
    await touch(p);
  },
  async deleteFile(id: number, path: string) {
    const p = await requireProject(id);
    const s = splitPath(path).join("/");
    const rows = (await db.files(id)).filter((r) => r.path === s || r.path.startsWith(s + "/"));
    if (!rows.length) throw new ApiError(404, "Not found");
    await db.deleteFiles(id, rows.map((r) => r.path));
    await touch(p);
  },
  async format(): Promise<{ content: string }> {
    throw new ApiError(501, "Code formatting is not available in the offline app");
  },

  // --- used by the on-device runtime -------------------------------------------------------
  async snapshot(id: number): Promise<Record<string, Uint8Array>> {
    const out: Record<string, Uint8Array> = {};
    for (const r of await db.files(id)) if (r.kind === "file" && !r.path.split("/").some((s) => s === ".compieler")) out[r.path] = r.data;
    return out;
  },
  async applyChanges(id: number, changed: Record<string, Uint8Array>, deleted: string[]) {
    const rows: FileRow[] = [];
    for (const [path, data] of Object.entries(changed)) {
      let parts: string[];
      try {
        parts = splitPath(path);
      } catch {
        continue;
      }
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join("/");
        if (!(await db.getFile(id, d))) rows.push({ pid: id, path: d, kind: "dir", data: new Uint8Array(0), size: 0, mtime: Date.now() });
      }
      rows.push({ pid: id, path: parts.join("/"), kind: "file", data, size: data.length, mtime: Date.now() });
    }
    await db.putFiles(rows);
    if (deleted.length) await db.deleteFiles(id, deleted);
    const p = await db.getProject(id);
    if (p && (rows.length || deleted.length)) await touch(p);
  },
};
