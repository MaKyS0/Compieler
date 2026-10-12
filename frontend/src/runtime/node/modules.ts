/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "assert";
import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { md5 } from "js-md5";
import { sha1 } from "js-sha1";
import { sha224, sha256 } from "js-sha256";
import { sha384, sha512 } from "js-sha512";
import pathMod from "path-browserify";
import querystring from "querystring";
import * as readableStream from "readable-stream";
import { StringDecoder } from "string_decoder";
import * as urlMod from "url";
import { util } from "./nodeUtil";
import { loop, track } from "./loop";
import { createReadline } from "./stdio";

const unsupported = (name: string, what = "") =>
  new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "__esModule" || typeof prop === "symbol") return undefined;
        return () => {
          throw new Error(`'${name}.${String(prop)}' is not available in the on-device JavaScript engine${what ? ` (${what})` : ""}`);
        };
      },
    },
  );

type Algo = { name: string; hex: (d: any) => string; hmac?: any };
const ALGOS: Record<string, any> = {
  md5: { fn: md5, hmac: md5.hmac },
  sha1: { fn: sha1, hmac: sha1.hmac },
  sha224: { fn: sha224, hmac: sha224.hmac },
  sha256: { fn: sha256, hmac: sha256.hmac },
  sha384: { fn: sha384, hmac: sha384.hmac },
  sha512: { fn: sha512, hmac: sha512.hmac },
};
const algo = (name: string) => {
  const a = ALGOS[name.toLowerCase().replace("-", "")];
  if (!a) throw new Error(`Digest method not supported: ${name}`);
  return a;
};
void (null as unknown as Algo);

function toBytes(data: any, enc?: string): Uint8Array {
  return typeof data === "string" ? new Uint8Array(Buffer.from(data, (enc as any) || "utf8")) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
}
function encodeOut(hex: string, enc?: string) {
  const buf = Buffer.from(hex, "hex");
  return enc ? buf.toString(enc as any) : buf;
}

class Hash {
  private chunks: Uint8Array[] = [];
  constructor(
    private name: string,
    private key?: any,
  ) {
    algo(name);
  }
  update(data: any, enc?: string) {
    this.chunks.push(toBytes(data, enc));
    return this;
  }
  digest(enc?: string) {
    const all = Buffer.concat(this.chunks as any);
    const a = algo(this.name);
    const hex = this.key !== undefined ? a.hmac(toBytes(this.key), all).toString?.() ?? String(a.hmac(toBytes(this.key), all)) : a.fn(all);
    return encodeOut(typeof hex === "string" ? hex : Buffer.from(hex).toString("hex"), enc);
  }
  copy() {
    const h = new Hash(this.name, this.key);
    h.chunks = [...this.chunks];
    return h;
  }
}

const cryptoMod: any = {
  randomBytes: (n: number, cb?: any) => {
    const b = Buffer.from(crypto.getRandomValues(new Uint8Array(n)));
    if (cb) return setTimeout(() => cb(null, b), 0);
    return b;
  },
  randomUUID: () => crypto.randomUUID(),
  randomInt: (a: number, b?: number | ((e: any, n: number) => void), cb?: any) => {
    const min = typeof b === "number" ? a : 0;
    const max = typeof b === "number" ? b : a;
    const n = min + Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296) * (max - min));
    const done = typeof b === "function" ? b : cb;
    if (done) setTimeout(() => done(null, n), 0);
    else return n;
  },
  getRandomValues: (a: any) => crypto.getRandomValues(a),
  createHash: (name: string) => new Hash(name),
  createHmac: (name: string, key: any) => new Hash(name, key),
  getHashes: () => Object.keys(ALGOS),
  timingSafeEqual: (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]),
  webcrypto: globalThis.crypto,
  subtle: globalThis.crypto?.subtle,
};

const osMod = {
  EOL: "\n",
  platform: () => "linux",
  type: () => "Linux",
  arch: () => "x64",
  release: () => "6.0.0",
  version: () => "#1",
  hostname: () => "localhost",
  homedir: () => "/home",
  tmpdir: () => "/tmp",
  endianness: () => "LE",
  uptime: () => performance.now() / 1000,
  loadavg: () => [0, 0, 0],
  totalmem: () => 4 * 1024 ** 3,
  freemem: () => 2 * 1024 ** 3,
  cpus: () => Array.from({ length: (navigator as any).hardwareConcurrency || 2 }, () => ({ model: "virtual", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })),
  networkInterfaces: () => ({}),
  userInfo: () => ({ username: "user", uid: 1000, gid: 1000, shell: "/bin/sh", homedir: "/home" }),
  availableParallelism: () => (navigator as any).hardwareConcurrency || 2,
  constants: { signals: {} },
};

function fileURLToPath(u: any) {
  return decodeURIComponent((typeof u === "string" ? new URL(u) : u).pathname);
}
const urlModule: any = {
  ...(urlMod as any),
  URL,
  URLSearchParams,
  fileURLToPath,
  pathToFileURL: (p: string) => new URL("file://" + pathMod.resolve("/work", p)),
};

const timersPromises = {
  setTimeout: (ms: number, value?: any) => track(new Promise((r) => setTimeout(() => r(value), ms))),
  setImmediate: (value?: any) => track(new Promise((r) => setTimeout(() => r(value), 0))),
  setInterval: async function* (ms: number, value?: any) {
    for (;;) yield await track(new Promise((r) => setTimeout(() => r(value), ms)));
  },
};

export function createBuiltins(fsModule: any): Record<string, any> {
  const rl = createReadline(false);
  const rlp = createReadline(true);
  const stream: any = { ...(readableStream as any), default: readableStream };
  const m: Record<string, any> = {
    assert: Object.assign(assert, { strict: (assert as any).strict ?? assert }),
    "assert/strict": (assert as any).strict ?? assert,
    buffer: { Buffer, constants: { MAX_LENGTH: 2 ** 31 - 1 }, kMaxLength: 2 ** 31 - 1 },
    crypto: cryptoMod,
    events: Object.assign(EventEmitter, { EventEmitter, once: (e: any, n: string) => new Promise((res, rej) => (e.once(n, (...a: any[]) => res(a)), e.once("error", rej))) }),
    fs: fsModule,
    "fs/promises": fsModule.promises,
    os: osMod,
    path: pathMod,
    "path/posix": pathMod,
    perf_hooks: { performance },
    punycode: {},
    querystring,
    readline: rl,
    "readline/promises": rlp,
    stream,
    "stream/promises": { pipeline: (...s: any[]) => new Promise((res, rej) => (readableStream as any).pipeline(...s, (e: any) => (e ? rej(e) : res(undefined)))), finished: (s: any) => new Promise((res, rej) => (readableStream as any).finished(s, (e: any) => (e ? rej(e) : res(undefined)))) },
    string_decoder: { StringDecoder },
    timers: { setTimeout, setInterval, setImmediate, clearTimeout, clearInterval, clearImmediate },
    "timers/promises": timersPromises,
    url: urlModule,
    util,
    "util/types": (util as any).types,
    module: { builtinModules: [], createRequire: () => undefined },
    process: undefined, // filled in by the runner
    constants: {},
    // not available in a WebView: fail loudly with an explanation instead of "module not found"
    child_process: unsupported("child_process", "no subprocesses on this device"),
    cluster: unsupported("cluster"),
    dgram: unsupported("dgram", "no raw network access"),
    dns: unsupported("dns", "no raw network access"),
    http: unsupported("http", "use the global fetch() instead"),
    https: unsupported("https", "use the global fetch() instead"),
    http2: unsupported("http2"),
    net: unsupported("net", "no raw network access"),
    tls: unsupported("tls"),
    worker_threads: { isMainThread: true, parentPort: null, workerData: null, Worker: class { constructor() { throw new Error("worker_threads.Worker is not available in the on-device JavaScript engine"); } }, threadId: 0 },
    zlib: unsupported("zlib"),
    v8: unsupported("v8"),
    vm: unsupported("vm"),
    inspector: unsupported("inspector"),
    async_hooks: { AsyncLocalStorage: class { run(_s: any, fn: any, ...a: any[]) { return fn(...a); } getStore() { return undefined; } }, AsyncResource: class {} },
  };
  void loop;
  return m;
}
