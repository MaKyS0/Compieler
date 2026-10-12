import type { Problem } from "../api/types";

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const strip = (s: string) => s.replace(ANSI, "");

const RESERVED = [".venv", "node_modules", ".compieler"];
function rel(path: string, workdir: string): string | null {
  const wd = workdir.replace(/\/+$/, "");
  let r: string;
  if (path.startsWith(wd + "/")) r = path.slice(wd.length + 1);
  else if (path.startsWith("/")) return null;
  else r = path.startsWith("./") ? path.slice(2) : path;
  if (r.split("/").some((s) => RESERVED.includes(s))) return null;
  return r;
}

const GCC = /^(?<file>[^\s:][^:\n]*):(?<line>\d+):(?:(?<col>\d+):)?\s*(?<sev>fatal error|error|warning|note):\s*(?<msg>.*)$/;
export function parseClang(text: string, workdir: string): Problem[] {
  const out: Problem[] = [];
  for (const raw of strip(text).split("\n")) {
    const m = GCC.exec(raw);
    if (!m?.groups) continue;
    const file = rel(m.groups.file, workdir);
    if (file === null) continue;
    const sev = m.groups.sev === "warning" ? "warning" : m.groups.sev === "note" ? "info" : "error";
    out.push({ file, line: +m.groups.line, col: +(m.groups.col ?? 1), severity: sev, message: m.groups.msg, source: "clang" });
  }
  return out;
}

export function parsePython(stderr: string, workdir: string): Problem[] {
  const lines = strip(stderr).split("\n");
  let frame: [string, number] | null = null;
  for (const raw of lines) {
    const m = /^\s*File "([^"]+)", line (\d+)/.exec(raw);
    if (m) {
      const f = rel(m[1], workdir);
      if (f !== null) frame = [f, +m[2]];
    }
  }
  if (!frame) return [];
  let msg = "";
  for (const raw of [...lines].reverse()) {
    const m = /^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning)):?\s*(.*)$/.exec(raw.trim());
    if (m) {
      msg = `${m[1]}: ${m[2]}`.replace(/: $/, "");
      break;
    }
  }
  return msg ? [{ file: frame[0], line: frame[1], col: 1, severity: "error", message: msg, source: "python" }] : [];
}

export function parseNode(stderr: string, workdir: string): Problem[] {
  const lines = strip(stderr).split("\n");
  let loc: [string, number] | null = null;
  let msg = "";
  for (const raw of lines) {
    const t = raw.trim();
    const m = /^(\/[^\s:]+|[\w./-]+\.(?:m|c)?js):(\d+)$/.exec(t);
    if (m && !loc) {
      const f = rel(m[1], workdir);
      if (f !== null) loc = [f, +m[2]];
    }
    const e = /^([A-Za-z]*Error):\s*(.*)$/.exec(t);
    if (e && !msg) msg = `${e[1]}: ${e[2]}`;
  }
  if (!loc) {
    for (const raw of lines) {
      const m = /\(?((?:\/|[\w.-]+\/)?[^\s()]+?):(\d+):(\d+)\)?$/.exec(raw.trim());
      if (m) {
        const f = rel(m[1], workdir);
        if (f !== null) {
          loc = [f, +m[2]];
          break;
        }
      }
    }
  }
  return loc && msg ? [{ file: loc[0], line: loc[1], col: 1, severity: "error", message: msg, source: "node" }] : [];
}

export function hints(language: string, stderr: string, phase: string): string[] {
  const out: string[] = [];
  const t = strip(stderr);
  if (language === "python") {
    const m = /ModuleNotFoundError: No module named '([^'.]+)/.exec(t);
    if (m)
      out.push(
        `Module '${m[1]}' is not available. Add it to requirements.txt, or install it from the Packages panel / with \`pip install ${m[1]}\` in the Terminal (needs an internet connection; only pure-Python wheels and Pyodide's built-in packages can be installed on the device).`,
      );
  }
  if (language === "javascript") {
    const m = /Cannot find module '([^'./][^']*)'/.exec(t);
    if (m) out.push(`Package '${m[1]}' is not available offline. Built-in modules (fs, path, util, events, readline, crypto, os, ...) work; other npm packages are fetched from a CDN when the device is online.`);
  }
  if (language === "cpp" && /no member named 'what'|cannot use '(throw|try)' with exceptions disabled/.test(t))
    out.push("C++ exceptions are not supported by the on-device compiler (WebAssembly/WASI). Use return codes instead of throw/try/catch.");
  if (phase === "install" && /Can't find a pure Python 3 wheel|No matching distribution|Failed to fetch|NetworkError/i.test(t))
    out.push("The package could not be installed: it needs an internet connection, and only pure-Python wheels (or packages bundled with Pyodide) work in the browser engine.");
  return out;
}
