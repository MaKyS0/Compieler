import type { Language, Project, ProjectSettings, Problem, ServerConfig, TreeEntry, User } from "./types";

const TOKEN_KEY = "compieler.token";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode) - session only */
  }
  memoryToken = token;
}
let memoryToken: string | null = null;
const token = () => getToken() ?? memoryToken;

async function request<T>(method: string, path: string, body?: unknown, opts: { form?: FormData; raw?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  let payload: BodyInit | undefined;
  if (opts.form) payload = opts.form;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, "Cannot reach the server. Check your connection.");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = await res.json();
      detail = typeof j.detail === "string" ? j.detail : Array.isArray(j.detail) ? j.detail.map((d: { msg: string }) => d.msg).join("; ") : detail;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, detail || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  if (opts.raw) return res as unknown as T;
  return (await res.json()) as T;
}

const q = (p: string) => encodeURIComponent(p);

export const api = {
  config: () => request<ServerConfig>("GET", "/config"),
  guest: () => request<{ token: string; user: User }>("POST", "/auth/guest"),
  me: () => request<User>("GET", "/auth/me"),
  register: (email: string, password: string) => request<{ token: string; user: User }>("POST", "/auth/register", { email, password }),
  login: (email: string, password: string) => request<{ token: string; user: User }>("POST", "/auth/login", { email, password }),

  projects: () => request<Project[]>("GET", "/projects"),
  createProject: (name: string, language: Language) => request<Project>("POST", "/projects", { name, language }),
  getProject: (id: number) => request<Project>("GET", `/projects/${id}`),
  patchProject: (id: number, patch: { name?: string; language?: Language; settings?: ProjectSettings }) =>
    request<Project>("PATCH", `/projects/${id}`, patch),
  deleteProject: (id: number) => request<void>("DELETE", `/projects/${id}`),
  importZip: (file: File, name?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (name) form.append("name", name);
    return request<Project>("POST", "/projects/import", undefined, { form });
  },
  async exportZip(id: number, name: string) {
    const res = await request<Response>("GET", `/projects/${id}/export`, undefined, { raw: true });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w.-]+/g, "_") || "project"}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },

  tree: (id: number) => request<TreeEntry[]>("GET", `/projects/${id}/tree`),
  readFile: (id: number, path: string) =>
    request<{ path: string; binary: boolean; size: number; content: string }>("GET", `/projects/${id}/file?path=${q(path)}`),
  writeFile: (id: number, path: string, content: string) => request<void>("PUT", `/projects/${id}/file`, { path, content }),
  deleteFile: (id: number, path: string) => request<void>("DELETE", `/projects/${id}/file?path=${q(path)}`),
  mkdir: (id: number, path: string) => request<void>("POST", `/projects/${id}/dir`, { path }),
  move: (id: number, src: string, dst: string) => request<void>("POST", `/projects/${id}/move`, { src, dst }),
  upload: (id: number, file: File, path: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("path", path);
    return request<void>("POST", `/projects/${id}/upload`, undefined, { form });
  },
  format: (language: Language, content: string, filename: string) =>
    request<{ content: string }>("POST", "/format", { language, content, filename }),
};

export type { Problem };
