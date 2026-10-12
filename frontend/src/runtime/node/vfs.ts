/* eslint-disable @typescript-eslint/no-explicit-any */
import { Buffer } from "buffer";
import pathMod from "path-browserify";

const path = pathMod as any;
export const CWD = "/work";

function fsError(code: string, syscall: string, p: string, msg: string) {
  const e: any = new Error(`${code}: ${msg}, ${syscall} '${p}'`);
  e.code = code;
  e.errno = { ENOENT: -2, EEXIST: -17, EISDIR: -21, ENOTDIR: -20, ENOTEMPTY: -39, EBADF: -9 }[code] ?? -1;
  e.syscall = syscall;
  e.path = p;
  return e;
}
const enoent = (sys: string, p: string) => fsError("ENOENT", sys, p, "no such file or directory");

export interface Stdio {
  readAll(): Uint8Array;
}

/** In-memory file system for the JavaScript engine; /work mirrors the project, everything else is scratch. */
export class VFS {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>(["/", "/tmp", "/work"]);
  private fds = new Map<number, { path: string; pos: number; flags: string }>();
  private nextFd = 3;
  initial = new Map<string, Uint8Array>();

  constructor(
    files: Record<string, Uint8Array>,
    private stdio: Stdio,
  ) {
    for (const [p, data] of Object.entries(files)) {
      const abs = `${CWD}/${p}`;
      this.files.set(abs, data);
      this.initial.set(abs, data);
      let d = path.dirname(abs);
      while (d !== "/" && !this.dirs.has(d)) (this.dirs.add(d), (d = path.dirname(d)));
    }
  }
  resolve(p: any): string {
    if (typeof p !== "string") p = p instanceof URL ? decodeURIComponent(p.pathname) : String(p);
    return path.resolve(CWD, p);
  }
  /** Files under /work that were created/changed/removed since start. */
  diff(): { changed: Record<string, Uint8Array>; deleted: string[] } {
    const changed: Record<string, Uint8Array> = {};
    for (const [abs, data] of this.files) if (abs.startsWith(CWD + "/") && this.initial.get(abs) !== data) changed[abs.slice(CWD.length + 1)] = data;
    const deleted = [...this.initial.keys()].filter((abs) => !this.files.has(abs)).map((abs) => abs.slice(CWD.length + 1));
    return { changed, deleted };
  }

  existsSync = (p: any) => {
    const a = this.resolve(p);
    return this.files.has(a) || this.dirs.has(a);
  };
  private bytes(data: any, enc?: string): Uint8Array {
    if (typeof data === "string") return new Uint8Array(Buffer.from(data, (enc as any) || "utf8"));
    if (data instanceof Uint8Array) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return new Uint8Array(Buffer.from(String(data)));
  }
  private encOf(o: any) {
    return typeof o === "string" ? o : o?.encoding;
  }
  readFileSync = (p: any, opts?: any) => {
    let data: Uint8Array;
    if (p === 0 || p === "/dev/stdin") data = this.stdio.readAll();
    else {
      const fd = typeof p === "number" ? this.fds.get(p) : null;
      const a = fd ? fd.path : this.resolve(p);
      if (this.dirs.has(a)) throw fsError("EISDIR", "read", a, "illegal operation on a directory");
      const f = this.files.get(a);
      if (!f) throw enoent("open", String(p));
      data = f;
    }
    const enc = this.encOf(opts);
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return enc ? buf.toString(enc) : Buffer.from(buf);
  };
  writeFileSync = (p: any, data: any, opts?: any) => {
    if (p === 1 || p === 2) {
      (globalThis as any).process[p === 1 ? "stdout" : "stderr"].write(typeof data === "string" ? data : Buffer.from(data).toString());
      return;
    }
    const a = this.resolve(p);
    if (this.dirs.has(a)) throw fsError("EISDIR", "open", a, "illegal operation on a directory");
    const parent = path.dirname(a);
    if (!this.dirs.has(parent)) throw enoent("open", String(p));
    const flag = typeof opts === "object" ? opts?.flag : undefined;
    const bytes = this.bytes(data, this.encOf(opts));
    if (flag === "a" || flag === "a+") {
      const old = this.files.get(a) ?? new Uint8Array(0);
      const merged = new Uint8Array(old.length + bytes.length);
      merged.set(old);
      merged.set(bytes, old.length);
      this.files.set(a, merged);
    } else this.files.set(a, bytes);
  };
  appendFileSync = (p: any, data: any, opts?: any) => this.writeFileSync(p, data, { ...(typeof opts === "string" ? { encoding: opts } : opts), flag: "a" });
  mkdirSync = (p: any, opts?: any) => {
    const a = this.resolve(p);
    const recursive = typeof opts === "object" && opts?.recursive;
    if (this.files.has(a)) throw fsError("EEXIST", "mkdir", String(p), "file already exists");
    if (this.dirs.has(a)) {
      if (recursive) return undefined;
      throw fsError("EEXIST", "mkdir", String(p), "file already exists");
    }
    const parent = path.dirname(a);
    if (!this.dirs.has(parent)) {
      if (!recursive) throw enoent("mkdir", String(p));
      this.mkdirSync(parent, opts);
    }
    this.dirs.add(a);
    return recursive ? a : undefined;
  };
  readdirSync = (p: any, opts?: any) => {
    const a = this.resolve(p);
    if (!this.dirs.has(a)) throw (this.files.has(a) ? fsError("ENOTDIR", "scandir", String(p), "not a directory") : enoent("scandir", String(p)));
    const names = new Map<string, boolean>();
    const prefix = a === "/" ? "/" : a + "/";
    for (const f of this.files.keys()) if (f.startsWith(prefix) && !f.slice(prefix.length).includes("/")) names.set(f.slice(prefix.length), false);
    for (const d of this.dirs) if (d !== a && d.startsWith(prefix) && !d.slice(prefix.length).includes("/")) names.set(d.slice(prefix.length), true);
    const sorted = [...names.entries()].sort(([x], [y]) => (x < y ? -1 : 1));
    if (typeof opts === "object" && opts?.withFileTypes)
      return sorted.map(([name, isDir]) => ({ name, isFile: () => !isDir, isDirectory: () => isDir, isSymbolicLink: () => false, parentPath: a, path: a }));
    return sorted.map(([n]) => n);
  };
  statSync = (p: any, opts?: any) => {
    const a = typeof p === "number" ? this.fds.get(p)?.path ?? "" : this.resolve(p);
    const isDir = this.dirs.has(a);
    const f = this.files.get(a);
    if (!isDir && !f) {
      if (opts?.throwIfNoEntry === false) return undefined;
      throw enoent("stat", String(p));
    }
    const now = new Date();
    return {
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => false,
      size: isDir ? 4096 : f!.length,
      mode: isDir ? 0o40755 : 0o100644,
      mtime: now,
      atime: now,
      ctime: now,
      birthtime: now,
      mtimeMs: +now,
    };
  };
  lstatSync = this.statSync;
  unlinkSync = (p: any) => {
    const a = this.resolve(p);
    if (this.dirs.has(a)) throw fsError("EISDIR", "unlink", String(p), "illegal operation on a directory");
    if (!this.files.delete(a)) throw enoent("unlink", String(p));
  };
  rmdirSync = (p: any, opts?: any) => {
    const a = this.resolve(p);
    if (!this.dirs.has(a)) throw enoent("rmdir", String(p));
    const prefix = a + "/";
    const inside = [...this.files.keys(), ...this.dirs].some((x) => x.startsWith(prefix));
    if (inside && !opts?.recursive) throw fsError("ENOTEMPTY", "rmdir", String(p), "directory not empty");
    for (const f of [...this.files.keys()]) if (f.startsWith(prefix)) this.files.delete(f);
    for (const d of [...this.dirs]) if (d.startsWith(prefix)) this.dirs.delete(d);
    this.dirs.delete(a);
  };
  rmSync = (p: any, opts?: any) => {
    const a = this.resolve(p);
    if (this.files.has(a)) return void this.files.delete(a);
    if (this.dirs.has(a)) return this.rmdirSync(p, { recursive: opts?.recursive });
    if (!opts?.force) throw enoent("rm", String(p));
  };
  renameSync = (from: any, to: any) => {
    const a = this.resolve(from);
    const b = this.resolve(to);
    if (this.files.has(a)) {
      this.files.set(b, this.files.get(a)!);
      this.files.delete(a);
    } else if (this.dirs.has(a)) {
      const move = (set: Map<string, Uint8Array>) => {
        for (const [k, v] of [...set]) if (k.startsWith(a + "/")) (set.delete(k), set.set(b + k.slice(a.length), v));
      };
      move(this.files);
      for (const d of [...this.dirs]) if (d === a || d.startsWith(a + "/")) (this.dirs.delete(d), this.dirs.add(b + d.slice(a.length)));
    } else throw enoent("rename", String(from));
  };
  copyFileSync = (from: any, to: any) => this.writeFileSync(to, this.readFileSync(from));
  accessSync = (p: any) => {
    if (!this.existsSync(p)) throw enoent("access", String(p));
  };
  openSync = (p: any, flags: any = "r") => {
    const a = this.resolve(p);
    const f = String(flags);
    if (f[0] === "r" && !this.files.has(a)) throw enoent("open", String(p));
    if (f[0] === "w") this.writeFileSync(a, "");
    if (f[0] === "a" && !this.files.has(a)) this.writeFileSync(a, "");
    const fd = this.nextFd++;
    this.fds.set(fd, { path: a, pos: 0, flags: f });
    return fd;
  };
  closeSync = (fd: number) => void this.fds.delete(fd);
  readSync = (fd: number, buf: Uint8Array, off = 0, len = buf.length, pos: number | null = null) => {
    if (fd === 0) {
      const chunk = (globalThis as any).__stdinRead?.(len) as Uint8Array | undefined;
      if (!chunk?.length) return 0;
      buf.set(chunk, off);
      return chunk.length;
    }
    const h = this.fds.get(fd);
    if (!h) throw fsError("EBADF", "read", String(fd), "bad file descriptor");
    const data = this.files.get(h.path) ?? new Uint8Array(0);
    const start = pos ?? h.pos;
    const n = Math.max(0, Math.min(len, data.length - start));
    buf.set(data.subarray(start, start + n), off);
    if (pos === null) h.pos += n;
    return n;
  };
  writeSync = (fd: number, data: any, ...rest: any[]) => {
    if (fd === 1 || fd === 2) {
      const s = typeof data === "string" ? data : Buffer.from(data).toString();
      (globalThis as any).process[fd === 1 ? "stdout" : "stderr"].write(s);
      return s.length;
    }
    const h = this.fds.get(fd);
    if (!h) throw fsError("EBADF", "write", String(fd), "bad file descriptor");
    const bytes = this.bytes(data, typeof rest[1] === "string" ? rest[1] : undefined);
    const old = this.files.get(h.path) ?? new Uint8Array(0);
    const at = h.flags[0] === "a" ? old.length : h.pos;
    const merged = new Uint8Array(Math.max(old.length, at + bytes.length));
    merged.set(old);
    merged.set(bytes, at);
    this.files.set(h.path, merged);
    h.pos = at + bytes.length;
    return bytes.length;
  };

  /** fs module object: sync, callback and promise flavours. */
  moduleObject(): any {
    const sync: Record<string, (...a: any[]) => any> = {};
    for (const n of ["existsSync", "readFileSync", "writeFileSync", "appendFileSync", "mkdirSync", "readdirSync", "statSync", "lstatSync", "unlinkSync", "rmdirSync", "rmSync", "renameSync", "copyFileSync", "accessSync", "openSync", "closeSync", "readSync", "writeSync"])
      sync[n] = (this as any)[n];
    const mod: any = { ...sync, constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 } };
    const promises: any = {};
    for (const [name, fn] of Object.entries(sync)) {
      if (name === "existsSync") continue;
      const base = name.replace(/Sync$/, "");
      mod[base] = (...args: any[]) => {
        const cb = typeof args[args.length - 1] === "function" ? args.pop() : () => undefined;
        let result: any;
        let error: any = null;
        try {
          result = fn(...args);
        } catch (e) {
          error = e;
        }
        setTimeout(() => (error ? cb(error) : cb(null, result)), 0);
      };
      promises[base] = (...args: any[]) =>
        new Promise((res, rej) =>
          setTimeout(() => {
            try {
              res(fn(...args));
            } catch (e) {
              rej(e);
            }
          }, 0),
        );
    }
    mod.exists = (p: any, cb: any) => setTimeout(() => cb(this.existsSync(p)), 0);
    mod.promises = promises;
    return mod;
  }
}
