"""Starter files for new projects."""
from __future__ import annotations

TEMPLATES: dict[str, dict[str, str]] = {
    "python": {
        "main.py": '''# Python 3 - the full standard library is available.
# Third-party packages: add them to requirements.txt or use the Packages panel.
import sys
import platform


def greet(name: str) -> str:
    return f"Hello, {name}!"


if __name__ == "__main__":
    name = input("Enter your name: ")
    print(greet(name))
    print(f"Python {platform.python_version()} on {sys.platform}")
''',
        "requirements.txt": "# One package per line, e.g.\n# requests\n# numpy\n",
    },
    "cpp": {
        "main.cpp": '''#include <iostream>
#include <string>

int main() {
    std::string name;
    std::cout << "Enter your name: ";
    std::getline(std::cin, name);
    std::cout << "Hello, " << name << "!" << std::endl;
    std::cout << "C++ standard: " << __cplusplus << std::endl;
    return 0;
}
''',
    },
    "javascript": {
        "index.js": '''// Node.js - run on the server, with fs, path, http, crypto, ...
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question("Enter your name: ", (name) => {
  console.log(`Hello, ${name}!`);
  console.log(`Node ${process.version}`);
  rl.close();
});
''',
        "package.json": '''{
  "name": "project",
  "version": "1.0.0",
  "main": "index.js",
  "private": true
}
''',
    },
}

LANGUAGES = tuple(TEMPLATES)
DEFAULT_ENTRY = {"python": "main.py", "cpp": "main.cpp", "javascript": "index.js"}
EXTENSIONS = {"python": (".py",), "cpp": (".cpp", ".cc", ".cxx"), "javascript": (".js", ".mjs", ".cjs")}


def detect_language(paths: list[str]) -> str:
    counts = {lang: sum(p.lower().endswith(ext) for p in paths) for lang, ext in EXTENSIONS.items()}
    best = max(counts, key=lambda k: counts[k])
    return best if counts[best] else "python"
