import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { CPP_HEADERS, CPP_KEYWORDS, CPP_SNIPPETS, STD_NAMES } from "./cppdata";
import pydata from "./pydata.json";

// Everything is bundled: no CDN, works offline and under a strict CSP.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    return label === "typescript" || label === "javascript" ? new tsWorker() : new editorWorker();
  },
};
loader.config({ monaco });

const K = monaco.languages.CompletionItemKind;
const SNIP = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
type Item = monaco.languages.CompletionItem;

function defineThemes() {
  monaco.editor.defineTheme("compieler-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6b7280", fontStyle: "italic" },
      { token: "keyword", foreground: "c084fc" },
      { token: "string", foreground: "86efac" },
      { token: "number", foreground: "fbbf77" },
      { token: "type", foreground: "7dd3fc" },
    ],
    colors: {
      "editor.background": "#18191c",
      "editor.foreground": "#d6d9de",
      "editorLineNumber.foreground": "#555a63",
      "editorLineNumber.activeForeground": "#a0a6b1",
      "editor.lineHighlightBackground": "#1f2024",
      "editor.selectionBackground": "#2f4468",
      "editorCursor.foreground": "#60a5fa",
      "editorIndentGuide.background1": "#2a2c31",
      "editorWidget.background": "#212226",
      "editorSuggestWidget.background": "#212226",
      "editorSuggestWidget.border": "#34363c",
      "scrollbarSlider.background": "#34363c80",
    },
  });
  monaco.editor.defineTheme("compieler-light", {
    base: "vs",
    inherit: true,
    rules: [{ token: "comment", foreground: "7a8190", fontStyle: "italic" }],
    colors: {
      "editor.background": "#fafafb",
      "editorLineNumber.foreground": "#9aa1ad",
      "editor.lineHighlightBackground": "#f1f2f5",
    },
  });
}

function pythonCompletions() {
  const modules = pydata.modules as unknown as Record<string, [string, string][]>;
  const KIND: Record<string, monaco.languages.CompletionItemKind> = {
    f: K.Function,
    c: K.Class,
    m: K.Module,
    k: K.Constant,
  };
  const snippets: [string, string, string][] = [
    ["def", "def ${1:name}(${2:args}):\n\t${0:pass}", "function"],
    ["class", "class ${1:Name}:\n\tdef __init__(self${2}):\n\t\t${0:pass}", "class"],
    ["for", "for ${1:i} in ${2:range(10)}:\n\t${0}", "for loop"],
    ["while", "while ${1:cond}:\n\t${0}", "while loop"],
    ["if", "if ${1:cond}:\n\t${0}", "if"],
    ["ifmain", 'if __name__ == "__main__":\n\t${0:main()}', "entry point guard"],
    ["try", "try:\n\t${1}\nexcept ${2:Exception} as e:\n\t${0:raise}", "try / except"],
    ["with", "with ${1:open('file')} as ${2:f}:\n\t${0}", "context manager"],
    ["lc", "[${1:x} for ${2:x} in ${3:iterable}]", "list comprehension"],
    ["input", 'input("${1:prompt}")', "read a line"],
  ];
  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: [".", " "],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const suggestions: Item[] = [];

      const member = /([A-Za-z_][\w.]*)\.\w*$/.exec(before);
      if (member) {
        const items = modules[member[1]] ?? modules[resolveAlias(model.getValue(), member[1])];
        if (items) for (const [n, k] of items) suggestions.push({ label: n, kind: KIND[k] ?? K.Variable, insertText: n, range });
        return { suggestions };
      }
      const imp = /^\s*(?:import|from)\s+([\w.]*)$/.exec(before) ?? /^\s*import\s+[\w., ]*,\s*(\w*)$/.exec(before);
      if (imp) {
        for (const m of pydata.stdlib) suggestions.push({ label: m, kind: K.Module, insertText: m, range });
        return { suggestions };
      }
      const from = /^\s*from\s+([\w.]+)\s+import\s+[\w, ]*$/.exec(before);
      if (from && modules[from[1]]) {
        for (const [n, k] of modules[from[1]]) suggestions.push({ label: n, kind: KIND[k] ?? K.Variable, insertText: n, range });
        return { suggestions };
      }
      for (const b of pydata.builtins) suggestions.push({ label: b, kind: K.Function, insertText: b, range, detail: "builtin" });
      for (const [label, insert, doc] of snippets)
        suggestions.push({ label, kind: K.Snippet, insertText: insert, insertTextRules: SNIP, documentation: doc, range, detail: "snippet" });
      for (const m of Object.keys(modules)) suggestions.push({ label: m, kind: K.Module, insertText: m, range, sortText: "z" + m });
      return { suggestions };
    },
  });
}

/** `import numpy as np` -> alias map, so `np.` works when numpy data exists; stdlib aliases only. */
function resolveAlias(source: string, name: string): string {
  const m = new RegExp(`import\\s+([\\w.]+)\\s+as\\s+${name}\\b`).exec(source);
  return m ? m[1] : name;
}

function cppCompletions() {
  monaco.languages.registerCompletionItemProvider("cpp", {
    triggerCharacters: [":", "<", "#"],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const suggestions: Item[] = [];
      if (/^\s*#\s*include\s*[<"]\w*$/.test(before)) {
        for (const h of CPP_HEADERS) suggestions.push({ label: h, kind: K.File, insertText: h, range });
        return { suggestions };
      }
      if (/std::\w*$/.test(before)) {
        for (const n of STD_NAMES) suggestions.push({ label: n, kind: K.Function, insertText: n, range });
        return { suggestions };
      }
      for (const k of CPP_KEYWORDS) suggestions.push({ label: k, kind: K.Keyword, insertText: k, range });
      for (const s of CPP_SNIPPETS)
        suggestions.push({ label: s.label, kind: K.Snippet, insertText: s.insert, insertTextRules: SNIP, documentation: s.doc, range, detail: "snippet" });
      for (const n of STD_NAMES) suggestions.push({ label: "std::" + n, kind: K.Function, insertText: "std::" + n, range, sortText: "z" + n });
      // identifiers already in the file
      const seen = new Set<string>();
      for (const w of model.getValue().match(/[A-Za-z_]\w{2,}/g) ?? []) if (!seen.has(w)) (seen.add(w), suggestions.push({ label: w, kind: K.Text, insertText: w, range, sortText: "y" + w }));
      return { suggestions };
    },
  });
}

const NODE_TYPES = `
declare var require: (id: string) => any;
declare var module: { exports: any };
declare var exports: any;
declare var __dirname: string;
declare var __filename: string;
declare var process: { argv: string[]; env: Record<string, string | undefined>; cwd(): string; exit(code?: number): never; stdin: any; stdout: any; stderr: any; platform: string; version: string; versions: Record<string,string>; hrtime: any; memoryUsage(): any; nextTick(fn: Function, ...a: any[]): void; on(ev: string, fn: Function): void };
declare var Buffer: any;
declare function setImmediate(fn: Function, ...a: any[]): any;
`;

function javascriptSetup() {
  const ts = monaco.typescript;
  ts.javascriptDefaults.setCompilerOptions({
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: false,
    lib: ["es2020"],
  });
  // Semantic checks would flag every Node built-in; syntax errors are still reported live.
  ts.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  ts.javascriptDefaults.addExtraLib(NODE_TYPES, "ts:node-globals.d.ts");
}

let done = false;
export function setupMonaco() {
  if (done) return;
  done = true;
  defineThemes();
  pythonCompletions();
  cppCompletions();
  javascriptSetup();
}
export { monaco };
