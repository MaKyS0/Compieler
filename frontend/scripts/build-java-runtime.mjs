// Rebuilds the two Compieler additions to the on-device Java engine (teavm-javac) from the Java sources in
// vendor/teavm-javac/patches. Needs a JDK (javac, 11 or newer). The results are committed, so a normal build
// does not run this; run it after changing a patch:   node scripts/build-java-runtime.mjs
//
//   vendor/teavm-javac/compile-classlib.bin   javac's view of the class library (upstream + fixes):
//       * java.lang.annotation.Annotation was broken upstream (marked as an annotation that extends itself,
//         so any @Override sent javac into endless recursion); the standard annotations get their members
//       * java.util.Scanner / InputMismatchException exist (TeaVM has none), System.exit(int) is declared
//   vendor/teavm-javac/compieler-runtime.bin  classes added to every program: TeaVM-side Scanner, Formatter
//       (TeaVM's crashes on %f in WebAssembly GC), InputStreamReader (TeaVM's needs NIO buffers that the
//       WebAssembly GC backend cannot compile), and org.compieler.IO (stdin + exit bridge to the worker).
//
// Both archives use teavm-javac's format: gzip of [u16 name length][name][u32 size][bytes] entries.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "teavm-javac");
const tmp = mkdtempSync(join(tmpdir(), "compieler-java-"));

export function readArchive(buf) {
  const b = gunzipSync(buf);
  const out = [];
  for (let i = 0; i < b.length; ) {
    const n = b.readUInt16BE(i);
    i += 2;
    const name = b.subarray(i, i + n).toString("utf8");
    i += n;
    const len = b.readUInt32BE(i);
    i += 4;
    out.push([name, Buffer.from(b.subarray(i, i + len))]);
    i += len;
  }
  return out;
}

export function writeArchive(entries) {
  const parts = [];
  for (const [name, data] of entries) {
    const nb = Buffer.from(name, "utf8");
    const head = Buffer.alloc(2 + nb.length + 4);
    head.writeUInt16BE(nb.length, 0);
    nb.copy(head, 2);
    head.writeUInt32BE(data.length, 2 + nb.length);
    parts.push(head, data);
  }
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

/** Byte offset just past the constant pool, and the pool's entry count. */
function skipConstantPool(d) {
  const count = d.readUInt16BE(8);
  let i = 10;
  for (let k = 1; k < count; k++) {
    const tag = d[i++];
    if (tag === 1) i += 2 + d.readUInt16BE(i);
    else if (tag === 3 || tag === 4) i += 4;
    else if (tag === 5 || tag === 6) (i += 8), k++;
    else if ([7, 8, 16, 19, 20].includes(tag)) i += 2;
    else if ([9, 10, 11, 12, 17, 18].includes(tag)) i += 4;
    else if (tag === 15) i += 3;
    else throw new Error(`bad constant pool tag ${tag}`);
  }
  return { count, end: i };
}

function skipMembers(d, i) {
  const n = d.readUInt16BE(i);
  i += 2;
  for (let m = 0; m < n; m++) {
    i += 6;
    const attrs = d.readUInt16BE(i);
    i += 2;
    for (let a = 0; a < attrs; a++) i += 6 + d.readUInt32BE(i + 2);
  }
  return i;
}

/** Adds `public static native` method declarations (javac only needs the signature). */
function addStaticNatives(d, methods) {
  const { count, end } = skipConstantPool(d);
  const pool = [];
  const refs = [];
  let idx = count;
  for (const [name, desc] of methods) {
    for (const s of [name, desc]) {
      const b = Buffer.from(s, "utf8");
      const e = Buffer.alloc(3);
      e[0] = 1;
      e.writeUInt16BE(b.length, 1);
      pool.push(e, b);
    }
    refs.push([idx, idx + 1]);
    idx += 2;
  }
  let i = end + 6;
  i += 2 + 2 * d.readUInt16BE(i);
  i = skipMembers(d, i); // fields
  const methodsAt = i;
  const methodsEnd = skipMembers(d, i);
  const counts = Buffer.alloc(2);
  counts.writeUInt16BE(idx);
  const mcount = Buffer.alloc(2);
  mcount.writeUInt16BE(d.readUInt16BE(methodsAt) + refs.length);
  const added = refs.map(([n, s]) => {
    const m = Buffer.alloc(8);
    m.writeUInt16BE(0x0109, 0); // public static native
    m.writeUInt16BE(n, 2);
    m.writeUInt16BE(s, 4);
    return m;
  });
  return Buffer.concat([d.subarray(0, 8), counts, d.subarray(10, end), ...pool, d.subarray(end, methodsAt), mcount, d.subarray(methodsAt + 2, methodsEnd), ...added, d.subarray(methodsEnd)]);
}

function walk(dir) {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
}

function javac(args) {
  execFileSync("javac", ["-nowarn", "-source", "11", "-target", "11", ...args], { stdio: ["ignore", "inherit", "inherit"] });
}

function classesUnder(dir) {
  return walk(dir).filter((f) => f.endsWith(".class")).map((f) => [relative(dir, f).split("\\").join("/"), readFileSync(f)]);
}

const upstreamSdk = readArchive(readFileSync(join(root, "upstream", "compile-classlib-teavm.bin")));

// ---- runtime additions, compiled against TeaVM's JSO annotations ------------------------------------
const jsoDir = join(tmp, "jso");
for (const [name, data] of upstreamSdk) {
  if (!name.startsWith("org/teavm/jso/") || name.split("/").length !== 4) continue;
  mkdirSync(dirname(join(jsoDir, name)), { recursive: true });
  writeFileSync(join(jsoDir, name), data);
}
const runtimeOut = join(tmp, "runtime");
javac(["-cp", jsoDir, "-d", runtimeOut, ...walk(join(root, "patches", "runtime")).filter((f) => f.endsWith(".java"))]);
const runtime = classesUnder(runtimeOut).sort(([a], [b]) => a.localeCompare(b));
writeFileSync(join(root, "compieler-runtime.bin"), writeArchive(runtime));

// ---- javac's class library ------------------------------------------------------------------------
// java.util.Scanner for javac is generated from the runtime TScanner, so the two always have the same API.
const sdkSrc = join(tmp, "sdk-src");
for (const f of walk(join(root, "patches", "sdk"))) {
  const dest = join(sdkSrc, relative(join(root, "patches", "sdk"), f));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(f));
}
const fromRuntime = (file, transform) => {
  const text = readFileSync(join(root, "patches", "runtime", "org", "teavm", "classlib", "java", "util", file), "utf8");
  const out = transform(
    text
      .replace(/^package org\.teavm\.classlib\.java\.util;/m, "package java.util;")
      .replace(/^import java\.util\.(Iterator|NoSuchElementException);\n/gm, "")
      .replace(/\bTScanner\b/g, "Scanner")
      .replace(/\bTInputMismatchException\b/g, "InputMismatchException"),
  );
  mkdirSync(join(sdkSrc, "java", "util"), { recursive: true });
  writeFileSync(join(sdkSrc, "java", "util", file.slice(1)), out);
};
fromRuntime("TScanner.java", (s) => s.replace(/source == System\.in \? org\.compieler\.IO\.STDIN : source/, "source"));
fromRuntime("TInputMismatchException.java", (s) => s);
const sdkOut = join(tmp, "sdk");
javac(["--patch-module", `java.base=${sdkSrc}`, "-d", sdkOut, ...walk(sdkSrc).filter((f) => f.endsWith(".java"))]);
const replacements = new Map(classesUnder(sdkOut));
const sdk = upstreamSdk.map(([name, data]) => {
  if (replacements.has(name)) {
    const r = replacements.get(name);
    replacements.delete(name);
    return [name, r];
  }
  if (name === "java/lang/System.class") return [name, addStaticNatives(data, [["exit", "(I)V"]])];
  return [name, data];
});
sdk.push(...replacements);
writeFileSync(join(root, "compile-classlib.bin"), writeArchive(sdk));

rmSync(tmp, { recursive: true, force: true });
console.log(`compile-classlib.bin: ${sdk.length} classes; compieler-runtime.bin: ${runtime.map(([n]) => n).join(", ")}`);
