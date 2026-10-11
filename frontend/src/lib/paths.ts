import type { Language, TreeEntry } from "../api/types";

export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export const EXT: Record<Language, string[]> = {
  python: [".py"],
  cpp: [".cpp", ".cc", ".cxx"],
  javascript: [".js", ".mjs", ".cjs"],
};

export function isRunnable(path: string, lang: Language): boolean {
  const lower = path.toLowerCase();
  return EXT[lang].some((e) => lower.endsWith(e));
}

export function monacoLanguage(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith(".py")) return "python";
  if (/\.(cpp|cc|cxx|c|h|hpp|hh|hxx|inl|tpp)$/.test(p)) return "cpp";
  if (/\.(js|mjs|cjs|jsx)$/.test(p)) return "javascript";
  if (/\.(ts|tsx)$/.test(p)) return "typescript";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".md")) return "markdown";
  if (p.endsWith(".html")) return "html";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".sh")) return "shell";
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "yaml";
  if (p.endsWith(".xml")) return "xml";
  if (p.endsWith(".sql")) return "sql";
  return "plaintext";
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children: TreeNode[];
}

export function buildTree(entries: TreeEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "dir", children: [] };
  const dirs = new Map<string, TreeNode>([["", root]]);
  const ensureDir = (path: string): TreeNode => {
    const hit = dirs.get(path);
    if (hit) return hit;
    const node: TreeNode = { name: basename(path), path, type: "dir", children: [] };
    dirs.set(path, node);
    ensureDir(dirname(path)).children.push(node);
    return node;
  };
  for (const e of entries) {
    if (e.type === "dir") ensureDir(e.path);
    else ensureDir(dirname(e.path)).children.push({ name: basename(e.path), path: e.path, type: "file", children: [] });
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
