// Downloads/copies the on-device engines into public/engines (git-ignored):
//   * Pyodide (CPython compiled to WebAssembly) + a base set of wheels  -> engines/pyodide
//   * YoWASP clang/lld + libc/libc++ sysroot (LLVM, WebAssembly)         -> engines/cpp
// Run automatically by `npm run build:standalone`. Safe to re-run: existing files are kept.
import { copyFileSync, existsSync, rmSync, mkdirSync, readFileSync, statSync, writeFileSync, createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "engines");
const PYODIDE_VERSION = JSON.parse(readFileSync(join(root, "node_modules/pyodide/package.json"), "utf8")).version;
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
// packages shipped inside the app so the basics work offline; everything else loads from the CDN when online
const BUNDLED = (process.env.PYODIDE_BUNDLE ?? "micropip,packaging,hashlib,lzma,pydecimal,sqlite3,ssl,pydoc-data,numpy").split(",").filter(Boolean);

async function download(url, dest) {
  if (existsSync(dest) && statSync(dest).size > 0) return;
  mkdirSync(dirname(dest), { recursive: true });
  process.stdout.write(`  fetch ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

// ---- Pyodide core --------------------------------------------------------------------
const py = join(out, "pyodide");
mkdirSync(py, { recursive: true });
for (const f of ["pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip"]) copyFileSync(join(root, "node_modules/pyodide", f), join(py, f));

const lock = JSON.parse(readFileSync(join(root, "node_modules/pyodide/pyodide-lock.json"), "utf8"));
const wanted = new Set();
const visit = (n) => {
  const key = n.toLowerCase().replace(/_/g, "-");
  if (wanted.has(key) || !lock.packages[key]) return;
  wanted.add(key);
  (lock.packages[key].depends ?? []).forEach(visit);
};
BUNDLED.forEach(visit);
for (const n of wanted) await download(CDN + lock.packages[n].file_name, join(py, lock.packages[n].file_name));
// lock file for the app: bundled wheels resolve locally, the rest from the CDN
for (const [n, p] of Object.entries(lock.packages)) if (!wanted.has(n)) p.file_name = CDN + p.file_name;
writeFileSync(join(py, "pyodide-lock.json"), JSON.stringify(lock));
writeFileSync(join(py, "version.json"), JSON.stringify({ version: PYODIDE_VERSION, bundled: [...wanted] }));

// ---- clang / lld / sysroot (WebAssembly, YoWASP build of LLVM) ------------------------
const cpp = join(out, "cpp");
mkdirSync(cpp, { recursive: true });
const yowasp = join(root, "node_modules/@yowasp/clang/gen");
const clangVersion = JSON.parse(readFileSync(join(root, "node_modules/@yowasp/clang/package.json"), "utf8")).version;
const HEAVY = ["llvm.core.wasm", "llvm.core2.wasm", "llvm.core3.wasm", "llvm.core4.wasm", "llvm-resources.tar"];
copyFileSync(join(yowasp, "bundle.js"), join(cpp, "bundle.js"));
// CPP_ENGINE=remote: keep ~100 MB of compiler out of the app; the worker downloads it from the CDN on first use and caches it.
const remote = process.env.CPP_ENGINE === "remote";
for (const f of HEAVY) {
  const dest = join(cpp, f);
  if (remote) rmSync(dest, { force: true });
  else copyFileSync(join(yowasp, f), dest);
}
if (remote) {
  const base = `https://cdn.jsdelivr.net/npm/@yowasp/clang@${clangVersion}/gen/`;
  writeFileSync(join(cpp, "remote.json"), JSON.stringify({ base, version: clangVersion, files: HEAVY, approxMB: 105 }));
} else rmSync(join(cpp, "remote.json"), { force: true });
console.log(`engines ready in ${out} (pyodide ${PYODIDE_VERSION}, clang ${clangVersion} (${remote ? "downloaded on first use" : "bundled"}), bundled: ${[...wanted].join(", ")})`);
