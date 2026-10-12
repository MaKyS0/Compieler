/**
 * Runtime support for running clang, lld and the compiled programs as WebAssembly modules.
 *
 * Derived from binji/wasm-clang (https://github.com/binji/wasm-clang, `shared.js`),
 * Copyright 2020 WebAssembly Community Group participants, Apache License 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0). Modified: TypeScript port, canvas API removed,
 * UTF-8 aware output with the file descriptor, blocking stdin supplied by the host, clock and
 * sleep implemented, exit codes returned instead of printed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export class ProcExit extends Error {
  constructor(public code: number) {
    super(`process exited with code ${code}.`);
  }
}

const ESUCCESS = 0;

function readCStr(u8: Uint8Array, o: number, len = -1): string {
  let str = "";
  const end = len === -1 ? u8.length : o + len;
  for (let i = o; i < end && u8[i] !== 0; ++i) str += String.fromCharCode(u8[i]);
  return str;
}

function importsOf(obj: any, names: string[]) {
  const result: Record<string, any> = {};
  for (const name of names) result[name] = obj[name].bind(obj);
  return result;
}

class Memory {
  buffer: ArrayBufferLike;
  u8: Uint8Array;
  u32: Uint32Array;
  constructor(public memory: WebAssembly.Memory) {
    this.buffer = memory.buffer;
    this.u8 = new Uint8Array(this.buffer);
    this.u32 = new Uint32Array(this.buffer);
  }
  check() {
    if (this.buffer !== this.memory.buffer) {
      this.buffer = this.memory.buffer;
      this.u8 = new Uint8Array(this.buffer);
      this.u32 = new Uint32Array(this.buffer);
    }
  }
  read32(o: number) {
    return this.u32[o >> 2];
  }
  write32(o: number, v: number) {
    this.u32[o >> 2] = v;
  }
  write64(o: number, lo: number, hi = 0) {
    this.write32(o, lo);
    this.write32(o + 4, hi);
  }
  readStr(o: number, len?: number) {
    return readCStr(this.u8, o, len ?? -1);
  }
  writeStr(o: number, str: string) {
    const bytes = new TextEncoder().encode(str);
    this.write(o, bytes);
    this.u8[o + bytes.length] = 0;
    return bytes.length + 1;
  }
  write(o: number, buf: ArrayBuffer | Uint8Array | number[]) {
    const src = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    new Uint8Array(this.buffer, o, src.length).set(src as ArrayLike<number>);
    return src.length;
  }
}

export interface MemFSOptions {
  memfsModule: WebAssembly.Module;
  /** Called for every write to fd 1/2 by the running program (raw bytes). */
  onWrite: (fd: number, bytes: Uint8Array) => void;
  /** Called when the program reads stdin; returns up to `max` bytes, empty array = EOF. May block. */
  readStdin: (max: number) => Uint8Array;
}

/** The WASI file system of the toolchain: an in-memory FS implemented as a small wasm module. */
export class MemFS {
  exports: any;
  mem!: Memory;
  hostMem: Memory | null = null;
  ready: Promise<void>;

  constructor(private opts: MemFSOptions) {
    const env = importsOf(this, ["abort", "host_write", "host_read", "memfs_log", "copy_in", "copy_out"]);
    this.ready = WebAssembly.instantiate(opts.memfsModule, { env }).then((instance) => {
      this.exports = instance.exports;
      this.mem = new Memory(this.exports.memory);
      this.exports.init();
    });
  }
  addDirectory(path: string) {
    this.mem.check();
    this.mem.write(this.exports.GetPathBuf(), new TextEncoder().encode(path));
    this.exports.AddDirectoryNode(new TextEncoder().encode(path).length);
  }
  addFile(path: string, contents: Uint8Array) {
    const pathBytes = new TextEncoder().encode(path);
    this.mem.check();
    this.mem.write(this.exports.GetPathBuf(), pathBytes);
    const inode = this.exports.AddFileNode(pathBytes.length, contents.length);
    const addr = this.exports.GetFileNodeAddress(inode);
    this.mem.check();
    this.mem.write(addr, contents);
  }
  getFileContents(path: string): Uint8Array {
    const pathBytes = new TextEncoder().encode(path);
    this.mem.check();
    this.mem.write(this.exports.GetPathBuf(), pathBytes);
    const inode = this.exports.FindNode(pathBytes.length);
    const addr = this.exports.GetFileNodeAddress(inode);
    const size = this.exports.GetFileNodeSize(inode);
    return new Uint8Array(this.mem.buffer, addr, size);
  }
  abort() {
    throw new Error("abort");
  }
  host_write(fd: number, iovs: number, iovsLen: number, nwrittenOut: number) {
    const hm = this.hostMem!;
    hm.check();
    let size = 0;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < iovsLen; ++i) {
      const buf = hm.read32(iovs);
      iovs += 4;
      const len = hm.read32(iovs);
      iovs += 4;
      parts.push(hm.u8.slice(buf, buf + len));
      size += len;
    }
    hm.write32(nwrittenOut, size);
    const all = new Uint8Array(size);
    let o = 0;
    for (const p of parts) (all.set(p, o), (o += p.length));
    this.opts.onWrite(fd, all);
    return ESUCCESS;
  }
  host_read(_fd: number, iovs: number, iovsLen: number, nread: number) {
    const hm = this.hostMem!;
    hm.check();
    let size = 0;
    for (let i = 0; i < iovsLen; ++i) {
      const buf = hm.read32(iovs);
      iovs += 4;
      const len = hm.read32(iovs);
      iovs += 4;
      if (len === 0) continue;
      const chunk = this.opts.readStdin(len);
      hm.check();
      if (!chunk.length) break;
      hm.write(buf, chunk);
      size += chunk.length;
      if (chunk.length < len) break; // a line at a time is enough for interactive programs
    }
    hm.write32(nread, size);
    return ESUCCESS;
  }
  memfs_log(buf: number, len: number) {
    this.mem.check();
    console.log(this.mem.readStr(buf, len));
  }
  copy_out(clangDst: number, memfsSrc: number, size: number) {
    this.hostMem!.check();
    this.mem.check();
    new Uint8Array(this.hostMem!.buffer, clangDst, size).set(new Uint8Array(this.mem.buffer, memfsSrc, size));
  }
  copy_in(memfsDst: number, clangSrc: number, size: number) {
    this.mem.check();
    this.hostMem!.check();
    new Uint8Array(this.mem.buffer, memfsDst, size).set(new Uint8Array(this.hostMem!.buffer, clangSrc, size));
  }
}

const sleepBuf = typeof SharedArrayBuffer !== "undefined" ? new Int32Array(new SharedArrayBuffer(4)) : null;
function sleepMs(ms: number) {
  if (ms <= 0) return;
  if (sleepBuf) Atomics.wait(sleepBuf, 0, 0, ms);
  else {
    const end = performance.now() + ms;
    while (performance.now() < end);
  }
}

/** One WASI process (clang, wasm-ld or the user's program) bound to the shared MemFS. */
export class WasiApp {
  argv: string[];
  environ: Record<string, string> = { USER: "user", LANG: "C.UTF-8" };
  exports: any;
  mem!: Memory;
  private ready: Promise<void>;

  constructor(
    module: WebAssembly.Module,
    memfs: MemFS,
    name: string,
    ...args: string[]
  ) {
    this.argv = [name, ...args];
    const wasi_unstable = importsOf(this, ["proc_exit", "environ_sizes_get", "environ_get", "args_sizes_get", "args_get", "random_get", "clock_time_get", "poll_oneoff"]);
    Object.assign(wasi_unstable, memfs.exports);
    // programs linked with libcanvas may import env.canvas_*; they are never called by our programs
    const env = new Proxy({}, { get: (_t, prop) => (typeof prop === "string" && prop.startsWith("canvas_") ? () => 0 : undefined) });
    this.ready = WebAssembly.instantiate(module, { wasi_unstable, env } as any).then((instance) => {
      this.exports = instance.exports;
      this.mem = new Memory(this.exports.memory);
      memfs.hostMem = this.mem;
    });
  }

  /** Runs `_start`. Returns the exit code; throws for traps. */
  async run(): Promise<number> {
    await this.ready;
    try {
      this.exports._start();
      return 0;
    } catch (exn) {
      if (exn instanceof ProcExit) return exn.code;
      throw exn;
    }
  }

  proc_exit(code: number) {
    throw new ProcExit(code);
  }
  environ_sizes_get(countOut: number, sizeOut: number) {
    this.mem.check();
    let size = 0;
    const names = Object.keys(this.environ);
    for (const n of names) size += n.length + this.environ[n].length + 2;
    this.mem.write64(countOut, names.length);
    this.mem.write64(sizeOut, size);
    return ESUCCESS;
  }
  environ_get(ptrs: number, buf: number) {
    this.mem.check();
    for (const n of Object.keys(this.environ)) {
      this.mem.write32(ptrs, buf);
      ptrs += 4;
      buf += this.mem.writeStr(buf, `${n}=${this.environ[n]}`);
    }
    this.mem.write32(ptrs, 0);
    return ESUCCESS;
  }
  args_sizes_get(argcOut: number, sizeOut: number) {
    this.mem.check();
    let size = 0;
    for (const a of this.argv) size += new TextEncoder().encode(a).length + 1;
    this.mem.write64(argcOut, this.argv.length);
    this.mem.write64(sizeOut, size);
    return ESUCCESS;
  }
  args_get(ptrs: number, buf: number) {
    this.mem.check();
    for (const a of this.argv) {
      this.mem.write32(ptrs, buf);
      ptrs += 4;
      buf += this.mem.writeStr(buf, a);
    }
    this.mem.write32(ptrs, 0);
    return ESUCCESS;
  }
  random_get(buf: number, len: number) {
    this.mem.check();
    crypto.getRandomValues(new Uint8Array(this.mem.buffer as ArrayBuffer, buf, len));
    return ESUCCESS;
  }
  clock_time_get(id: number, _precision: number, timeOut: number) {
    this.mem.check();
    // 0 = realtime, 1 = monotonic; both reported in nanoseconds as a u64
    const ms = id === 0 ? Date.now() : performance.now();
    const ns = BigInt(Math.floor(ms * 1e6));
    this.mem.write64(timeOut, Number(ns & 0xffffffffn), Number(ns >> 32n));
    return ESUCCESS;
  }
  poll_oneoff(inPtr: number, outPtr: number, nsubs: number, neventsOut: number) {
    // Only clock subscriptions (sleep_for / sleep) are supported: wait for the earliest one.
    this.mem.check();
    let wait = Infinity;
    let userdata = [0, 0];
    for (let i = 0; i < nsubs; i++) {
      const base = inPtr + i * 48;
      const tag = this.mem.u8[base + 8];
      if (tag === 0) {
        const lo = this.mem.read32(base + 24);
        const hi = this.mem.read32(base + 28);
        const ms = (hi * 4294967296 + lo) / 1e6;
        if (ms < wait) {
          wait = ms;
          userdata = [this.mem.read32(base), this.mem.read32(base + 4)];
        }
      }
    }
    if (wait !== Infinity) sleepMs(wait);
    this.mem.check();
    this.mem.write32(outPtr, userdata[0]);
    this.mem.write32(outPtr + 4, userdata[1]);
    this.mem.u8[outPtr + 8] = 0; // error: success
    this.mem.u8[outPtr + 10] = 0; // type: clock
    this.mem.write32(neventsOut, 1);
    return ESUCCESS;
  }
}

/** Unpacks a ustar archive into the MemFS. */
export function untar(buffer: ArrayBuffer, memfs: MemFS) {
  const u8 = new Uint8Array(buffer);
  let off = 0;
  const str = (len: number) => {
    const s = readCStr(u8, off, len);
    off += len;
    return s;
  };
  const oct = (len: number) => parseInt(str(len), 8);
  const align = () => (off = (off + 511) & ~511);
  while (off + 512 <= u8.length) {
    const filename = str(100);
    str(8); // mode
    str(8); // uid
    str(8); // gid
    const size = oct(12);
    str(12); // mtime
    str(8); // checksum
    const type = str(1);
    str(100); // linkname
    if (str(8) !== "ustar  ") return;
    off += 32 + 32 + 8 + 8 + 155;
    align();
    if (type === "0") {
      memfs.addFile(filename, u8.subarray(off, off + size));
      off += size;
      align();
    } else if (type === "5") memfs.addDirectory(filename);
  }
}
