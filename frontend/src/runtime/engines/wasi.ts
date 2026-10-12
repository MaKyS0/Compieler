// Minimal WASI preview1 host for programs compiled by the on-device clang: stdio, clock, random,
// environment, sleep and a small in-memory file system (the project's files, read/write).
export class ProcExit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

const ESUCCESS = 0, EBADF = 8, EEXIST = 20, EINVAL = 28, ENOENT = 44, ENOSYS = 52, ESPIPE = 70;
const FILETYPE_CHAR = 2, FILETYPE_DIR = 3, FILETYPE_FILE = 4;
const PREOPEN_FD = 3;

interface OpenFile {
  path: string;
  pos: number;
  append: boolean;
}

export interface WasiOptions {
  argv: string[];
  files: Record<string, Uint8Array>;
  readStdin: (max: number) => Uint8Array;
  onWrite: (fd: 1 | 2, bytes: Uint8Array) => void;
}

let sleepBuf: Int32Array | null = null;
function sleepMs(ms: number) {
  if (ms <= 0) return;
  try {
    sleepBuf ??= new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sleepBuf, 0, 0, ms);
  } catch {
    const end = performance.now() + ms;
    while (performance.now() < end);
  }
}

export class WasiRuntime {
  private memory!: WebAssembly.Memory;
  private fds = new Map<number, OpenFile>();
  private nextFd = 4;
  private enc = new TextEncoder();
  private dec = new TextDecoder();
  private env = ["USER=user", "LANG=C.UTF-8"];

  constructor(private o: WasiOptions) {}

  attach(memory: WebAssembly.Memory) {
    this.memory = memory;
  }

  private dv() {
    return new DataView(this.memory.buffer);
  }
  private u8() {
    return new Uint8Array(this.memory.buffer);
  }
  private norm(p: string) {
    const out: string[] = [];
    for (const part of p.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return out.join("/");
  }

  /** Import object for WebAssembly.instantiate. Unknown functions answer ENOSYS instead of failing to link. */
  imports(): WebAssembly.Imports {
    const impl: Record<string, (...a: any[]) => number | void> = {
      proc_exit: (code: number) => {
        throw new ProcExit(code);
      },
      args_sizes_get: (argc: number, size: number) => {
        const dv = this.dv();
        dv.setUint32(argc, this.o.argv.length, true);
        dv.setUint32(size, this.o.argv.reduce((n, a) => n + this.enc.encode(a).length + 1, 0), true);
        return ESUCCESS;
      },
      args_get: (ptrs: number, buf: number) => this.writeStrings(this.o.argv, ptrs, buf),
      environ_sizes_get: (count: number, size: number) => {
        const dv = this.dv();
        dv.setUint32(count, this.env.length, true);
        dv.setUint32(size, this.env.reduce((n, a) => n + a.length + 1, 0), true);
        return ESUCCESS;
      },
      environ_get: (ptrs: number, buf: number) => this.writeStrings(this.env, ptrs, buf),
      random_get: (buf: number, len: number) => {
        const view = new Uint8Array(this.memory.buffer, buf, len);
        for (let i = 0; i < len; i += 65536) crypto.getRandomValues(view.subarray(i, Math.min(len, i + 65536)));
        return ESUCCESS;
      },
      clock_time_get: (id: number, _precision: bigint, out: number) => {
        const ms = id === 0 ? Date.now() : performance.now();
        this.dv().setBigUint64(out, BigInt(Math.floor(ms * 1e6)), true);
        return ESUCCESS;
      },
      poll_oneoff: (inPtr: number, outPtr: number, nsubs: number, neventsOut: number) => {
        const dv = this.dv();
        let wait = Infinity;
        let user = 0n;
        for (let i = 0; i < nsubs; i++) {
          const base = inPtr + i * 48;
          if (dv.getUint8(base + 8) === 0) {
            const ms = Number(dv.getBigUint64(base + 24, true)) / 1e6;
            if (ms < wait) (wait = ms), (user = dv.getBigUint64(base, true));
          }
        }
        if (wait !== Infinity) sleepMs(wait);
        const d2 = this.dv();
        d2.setBigUint64(outPtr, user, true);
        d2.setUint16(outPtr + 8, 0, true);
        d2.setUint8(outPtr + 10, 0);
        d2.setUint32(neventsOut, 1, true);
        return ESUCCESS;
      },
      sched_yield: () => ESUCCESS,
      fd_prestat_get: (fd: number, buf: number) => {
        if (fd !== PREOPEN_FD) return EBADF;
        const dv = this.dv();
        dv.setUint8(buf, 0);
        dv.setUint32(buf + 4, 1, true);
        return ESUCCESS;
      },
      fd_prestat_dir_name: (fd: number, path: number, len: number) => {
        if (fd !== PREOPEN_FD) return EBADF;
        if (len > 0) this.u8()[path] = 46; // "."
        return ESUCCESS;
      },
      fd_fdstat_get: (fd: number, buf: number) => {
        const dv = this.dv();
        let type: number;
        if (fd <= 2) type = FILETYPE_CHAR;
        else if (fd === PREOPEN_FD) type = FILETYPE_DIR;
        else if (this.fds.has(fd)) type = FILETYPE_FILE;
        else return EBADF;
        dv.setUint8(buf, type);
        dv.setUint16(buf + 2, 0, true);
        dv.setBigUint64(buf + 8, 0xffffffffffffffffn, true);
        dv.setBigUint64(buf + 16, 0xffffffffffffffffn, true);
        return ESUCCESS;
      },
      fd_fdstat_set_flags: () => ESUCCESS,
      fd_close: (fd: number) => (fd <= PREOPEN_FD ? ESUCCESS : this.fds.delete(fd) ? ESUCCESS : EBADF),
      fd_read: (fd: number, iovs: number, iovsLen: number, nreadOut: number) => {
        let total = 0;
        if (fd === 0) {
          for (let i = 0; i < iovsLen; i++) {
            const dv = this.dv();
            const ptr = dv.getUint32(iovs + i * 8, true);
            const len = dv.getUint32(iovs + i * 8 + 4, true);
            if (!len) continue;
            const chunk = this.o.readStdin(len);
            if (!chunk.length) break;
            this.u8().set(chunk, ptr);
            total += chunk.length;
            if (chunk.length < len) break; // one line at a time is enough for interactive programs
          }
        } else {
          const f = this.fds.get(fd);
          if (!f) return EBADF;
          const data = this.o.files[f.path] ?? new Uint8Array();
          for (let i = 0; i < iovsLen; i++) {
            const dv = this.dv();
            const ptr = dv.getUint32(iovs + i * 8, true);
            const len = dv.getUint32(iovs + i * 8 + 4, true);
            const n = Math.min(len, data.length - f.pos);
            if (n <= 0) break;
            this.u8().set(data.subarray(f.pos, f.pos + n), ptr);
            f.pos += n;
            total += n;
            if (n < len) break;
          }
        }
        this.dv().setUint32(nreadOut, total, true);
        return ESUCCESS;
      },
      fd_write: (fd: number, iovs: number, iovsLen: number, nwrittenOut: number) => {
        let total = 0;
        const f = fd > PREOPEN_FD ? this.fds.get(fd) : undefined;
        if (fd > PREOPEN_FD && !f) return EBADF;
        if (fd === 0 || fd === PREOPEN_FD) return EBADF;
        for (let i = 0; i < iovsLen; i++) {
          const dv = this.dv();
          const ptr = dv.getUint32(iovs + i * 8, true);
          const len = dv.getUint32(iovs + i * 8 + 4, true);
          if (!len) continue;
          const bytes = new Uint8Array(this.memory.buffer, ptr, len);
          if (f) this.writeFile(f, bytes);
          else this.o.onWrite(fd as 1 | 2, bytes.slice());
          total += len;
        }
        this.dv().setUint32(nwrittenOut, total, true);
        return ESUCCESS;
      },
      fd_seek: (fd: number, offset: bigint, whence: number, out: number) => {
        const f = this.fds.get(fd);
        if (!f) return fd <= 2 ? ESPIPE : EBADF;
        const size = this.o.files[f.path]?.length ?? 0;
        const base = whence === 0 ? 0 : whence === 1 ? f.pos : whence === 2 ? size : -1;
        if (base < 0) return EINVAL;
        const pos = base + Number(offset);
        if (pos < 0) return EINVAL;
        f.pos = pos;
        this.dv().setBigUint64(out, BigInt(pos), true);
        return ESUCCESS;
      },
      path_open: (dirfd: number, _dirflags: number, pathPtr: number, pathLen: number, oflags: number, _rb: bigint, _ri: bigint, fdflags: number, fdOut: number) => {
        if (dirfd !== PREOPEN_FD) return EBADF;
        const path = this.norm(this.dec.decode(new Uint8Array(this.memory.buffer, pathPtr, pathLen)));
        const exists = path in this.o.files;
        const CREAT = 1, DIRECTORY = 2, EXCL = 4, TRUNC = 8;
        if (oflags & DIRECTORY) return ENOENT;
        if (exists && oflags & CREAT && oflags & EXCL) return EEXIST;
        if (!exists && !(oflags & CREAT)) return ENOENT;
        if (!exists || oflags & TRUNC) this.o.files[path] = new Uint8Array();
        const fd = this.nextFd++;
        this.fds.set(fd, { path, pos: 0, append: !!(fdflags & 1) });
        this.dv().setUint32(fdOut, fd, true);
        return ESUCCESS;
      },
    };
    const wasi = new Proxy(impl, {
      get: (t, prop) => (typeof prop === "string" ? (t[prop] ?? (() => ENOSYS)) : undefined),
      has: () => true,
    });
    // programs linked with libcanvas may import env.canvas_*; they are never called by our programs
    const env = new Proxy({}, { get: (_t, prop) => (typeof prop === "string" && prop.startsWith("canvas_") ? () => 0 : undefined) });
    return { wasi_snapshot_preview1: wasi, wasi_unstable: wasi, env } as unknown as WebAssembly.Imports;
  }

  private writeStrings(items: string[], ptrs: number, buf: number): number {
    const dv = this.dv();
    const u8 = this.u8();
    for (const item of items) {
      dv.setUint32(ptrs, buf, true);
      ptrs += 4;
      const bytes = this.enc.encode(item);
      u8.set(bytes, buf);
      u8[buf + bytes.length] = 0;
      buf += bytes.length + 1;
    }
    return ESUCCESS;
  }

  private writeFile(f: OpenFile, bytes: Uint8Array) {
    let data = this.o.files[f.path] ?? new Uint8Array();
    if (f.append) f.pos = data.length;
    const end = f.pos + bytes.length;
    if (end > data.length) {
      const grown = new Uint8Array(end);
      grown.set(data);
      data = grown;
    }
    data.set(bytes, f.pos);
    f.pos = end;
    this.o.files[f.path] = data;
  }
}
