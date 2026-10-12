import type { Language } from "../api/types";

export const TEMPLATES: Record<Language, Record<string, string>> = {
  python: {
    "main.py": `# Python 3 - runs on this device (CPython compiled to WebAssembly).
# Packages: add them to requirements.txt or use the Packages panel (needs internet).
import sys
import platform


def greet(name: str) -> str:
    return f"Hello, {name}!"


if __name__ == "__main__":
    name = input("Enter your name: ")
    print(greet(name))
    print(f"Python {platform.python_version()} on {sys.platform}")
`,
    "requirements.txt": "# One package per line, e.g.\n# requests\n# numpy\n",
  },
  cpp: {
    "main.cpp": `#include <iostream>
#include <string>

int main() {
    std::string name;
    std::cout << "Enter your name: ";
    std::getline(std::cin, name);
    std::cout << "Hello, " << name << "!" << std::endl;
    std::cout << "C++ standard: " << __cplusplus << std::endl;
    return 0;
}
`,
  },
  javascript: {
    "index.js": `// JavaScript - runs on this device with Node-style fs, path, util, events, readline, ...
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("Enter your name: ", (name) => {
  console.log(\`Hello, \${name}!\`);
  console.log(\`Engine: \${process.version}\`);
  rl.close();
});
`,
    "package.json": `{
  "name": "project",
  "version": "1.0.0",
  "main": "index.js",
  "private": true
}
`,
  },
};

export const DEFAULT_ENTRY: Record<Language, string> = { python: "main.py", cpp: "main.cpp", javascript: "index.js" };
export const EXTENSIONS: Record<Language, string[]> = { python: [".py"], cpp: [".cpp", ".cc", ".cxx"], javascript: [".js", ".mjs", ".cjs"] };

export function detectLanguage(paths: string[]): Language {
  let best: Language = "python";
  let bestN = 0;
  for (const lang of Object.keys(EXTENSIONS) as Language[]) {
    const n = paths.filter((p) => EXTENSIONS[lang].some((e) => p.toLowerCase().endsWith(e))).length;
    if (n > bestN) (best = lang), (bestN = n);
  }
  return best;
}
