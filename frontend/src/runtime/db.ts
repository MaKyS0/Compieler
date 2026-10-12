/** Tiny promise wrapper around IndexedDB: projects and files of the on-device app. */
export interface ProjectRow {
  id: number;
  name: string;
  language: "python" | "cpp" | "javascript";
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_opened_at: string;
}
export interface FileRow {
  pid: number;
  path: string;
  kind: "file" | "dir";
  data: Uint8Array;
  size: number;
  mtime: number;
}

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open("compieler", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore("projects", { keyPath: "id", autoIncrement: true });
        const files = db.createObjectStore("files", { keyPath: ["pid", "path"] });
        files.createIndex("pid", "pid");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB is not available"));
    });
  }
  return dbp;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await open();
  const t = db.transaction(stores, mode);
  const done = new Promise<void>((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error ?? new Error("transaction aborted"));
  });
  const result = await fn(t);
  await done;
  return result;
}

export const db = {
  async listProjects(): Promise<ProjectRow[]> {
    return tx(["projects"], "readonly", (t) => wrap(t.objectStore("projects").getAll() as IDBRequest<ProjectRow[]>));
  },
  async getProject(id: number): Promise<ProjectRow | undefined> {
    return tx(["projects"], "readonly", (t) => wrap(t.objectStore("projects").get(id) as IDBRequest<ProjectRow | undefined>));
  },
  async putProject(p: Omit<ProjectRow, "id"> & { id?: number }): Promise<ProjectRow> {
    return tx(["projects"], "readwrite", async (t) => {
      const key = await wrap(t.objectStore("projects").put(p));
      return { ...p, id: key as number } as ProjectRow;
    });
  },
  async deleteProject(id: number): Promise<void> {
    await tx(["projects", "files"], "readwrite", async (t) => {
      t.objectStore("projects").delete(id);
      const idx = t.objectStore("files").index("pid");
      const keys = await wrap(idx.getAllKeys(id));
      for (const k of keys) t.objectStore("files").delete(k);
    });
  },
  async files(pid: number): Promise<FileRow[]> {
    return tx(["files"], "readonly", (t) => wrap(t.objectStore("files").index("pid").getAll(pid) as IDBRequest<FileRow[]>));
  },
  async getFile(pid: number, path: string): Promise<FileRow | undefined> {
    return tx(["files"], "readonly", (t) => wrap(t.objectStore("files").get([pid, path]) as IDBRequest<FileRow | undefined>));
  },
  async putFiles(rows: FileRow[]): Promise<void> {
    await tx(["files"], "readwrite", async (t) => {
      for (const r of rows) t.objectStore("files").put(r);
    });
  },
  async deleteFiles(pid: number, paths: string[]): Promise<void> {
    await tx(["files"], "readwrite", async (t) => {
      for (const p of paths) t.objectStore("files").delete([pid, p]);
    });
  },
};
