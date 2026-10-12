/** A tiny shell for the Terminal tab of the on-device app: file commands plus launchers for the engines. */
import { localApi } from "../api/local";
import type { RunRequest } from "../api/types";
import { db } from "./db";

export interface ShellHost {
  projectId: number;
  write: (stream: "stdout" | "stderr", data: string) => void;
  start: () => void;
  end: (code: number) => void;
  busy: () => boolean;
  run: (req: RunRequest) => void;
  install: (packages: string[]) => void;
}

const HELP = `Commands available in this offline terminal:
  ls [dir]            list files            cat <file>          print a file
  pwd, echo, clear    mkdir <dir>           rm [-r] <path>      mv <from> <to>
  python <file.py> [args]     run a Python file      node <file.js> [args]   run a JavaScript file
  g++ <file.cpp> [-std=c++17] compile and run a C++ file
  pip install <pkg>   install a package (internet needed; pure-Python wheels and Pyodide packages)
  help                this text
While a program runs, type input and press Enter; Ctrl+D sends end-of-file, Ctrl+C stops it.
`;

export async function runShell(command: string, h: ShellHost) {
  const { tokenize } = await import("./LocalSocket");
  let argv: string[];
  try {
    argv = tokenize(command);
  } catch (e) {
    h.start();
    h.write("stderr", `${(e as Error).message}\n`);
    return h.end(2);
  }
  const [cmd, ...args] = argv;
  if (!cmd) return;
  const id = h.projectId;
  const fail = (msg: string, code = 1) => (h.write("stderr", msg + "\n"), h.end(code));

  // engine launchers
  const launch = async (entry: string, rest: string[], extra: Partial<RunRequest> = {}) => {
    if (h.busy()) return;
    const project = await db.getProject(id);
    const files = await localApi.snapshot(id);
    if (!files[entry]) {
      h.start();
      return fail(`${entry}: no such file`, 2);
    }
    void project;
    h.run({ entry, args: rest.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" "), ...extra });
  };
  if ((cmd === "python" || cmd === "python3") && args[0] && !args[0].startsWith("-")) return launch(args[0], args.slice(1));
  if (cmd === "node" && args[0]) return launch(args[0], args.slice(1));
  if (["g++", "clang++", "c++"].includes(cmd)) {
    const src = args.find((a) => /\.(cpp|cc|cxx)$/i.test(a));
    const std = args.find((a) => a.startsWith("-std="))?.slice(5);
    if (!src) {
      h.start();
      return fail(`${cmd}: no input files`);
    }
    return launch(src, [], { std });
  }
  if (cmd === "pip" || cmd === "pip3" || (cmd === "python" && args[0] === "-m" && args[1] === "pip")) {
    const rest = cmd === "python" ? args.slice(2) : args;
    if (rest[0] === "install") {
      const pkgs = rest.slice(1).filter((a) => !a.startsWith("-"));
      if (!pkgs.length) {
        h.start();
        return fail("pip install: no packages given", 2);
      }
      return h.install(pkgs);
    }
    h.start();
    return fail("Only `pip install <package>` is available in the offline terminal.", 2);
  }
  if (cmd === "npm" || cmd === "npx") {
    h.start();
    h.write("stdout", "npm is not available on this device. Packages your program requires are fetched from a CDN automatically (internet needed).\n");
    return h.end(0);
  }

  h.start();
  try {
    switch (cmd) {
      case "help":
      case "--help":
        h.write("stdout", HELP);
        return h.end(0);
      case "pwd":
        h.write("stdout", "/work\n");
        return h.end(0);
      case "echo":
        h.write("stdout", args.join(" ") + "\n");
        return h.end(0);
      case "ls": {
        const dir = (args.find((a) => !a.startsWith("-")) ?? "").replace(/^\/work\/?/, "").replace(/\/$/, "");
        const tree = await localApi.tree(id);
        const prefix = dir ? dir + "/" : "";
        const names = new Map<string, boolean>();
        for (const e of tree) {
          if (!e.path.startsWith(prefix) || e.path === dir) continue;
          const rest = e.path.slice(prefix.length);
          const first = rest.split("/")[0];
          names.set(first, names.get(first) || rest.includes("/") || e.type === "dir");
        }
        if (dir && !names.size && !tree.some((e) => e.path === dir)) return fail(`ls: cannot access '${dir}': No such file or directory`, 2);
        h.write("stdout", [...names].sort(([a], [b]) => a.localeCompare(b)).map(([n, d]) => (d ? n + "/" : n)).join("\n") + (names.size ? "\n" : ""));
        return h.end(0);
      }
      case "cat": {
        if (!args.length) return fail("cat: missing file operand", 1);
        for (const a of args) {
          const f = await localApi.readFile(id, a.replace(/^\/work\//, ""));
          if (f.binary) return fail(`cat: ${a}: binary file`, 1);
          h.write("stdout", f.content);
        }
        return h.end(0);
      }
      case "mkdir":
        for (const a of args.filter((x) => !x.startsWith("-"))) await localApi.mkdir(id, a);
        return h.end(0);
      case "rm":
        for (const a of args.filter((x) => !x.startsWith("-"))) await localApi.deleteFile(id, a);
        return h.end(0);
      case "mv":
        if (args.length !== 2) return fail("usage: mv <from> <to>", 2);
        await localApi.move(id, args[0], args[1]);
        return h.end(0);
      default:
        return fail(`${cmd}: command not found (type 'help')`, 127);
    }
  } catch (e) {
    return fail(`${cmd}: ${(e as Error).message}`, 1);
  }
}
