"""Turn compiler / interpreter output into editor problems and friendly hints."""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
GCC = re.compile(r"^(?P<file>[^\s:][^:\n]*):(?P<line>\d+):(?:(?P<col>\d+):)?\s*(?P<sev>fatal error|error|warning|note):\s*(?P<msg>.*)$")
PY_FILE = re.compile(r'^\s*File "(?P<file>[^"]+)", line (?P<line>\d+)')
PY_EXC = re.compile(r"^(?P<name>[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning)):?\s*(?P<msg>.*)$")
NODE_LOC = re.compile(r"^(?P<file>/[^\s:]+|[A-Za-z]:\\[^:]+|[\w./-]+\.(?:m|c)?js):(?P<line>\d+)$")
NODE_EXC = re.compile(r"^(?P<name>[A-Za-z]*Error):\s*(?P<msg>.*)$")
NODE_AT = re.compile(r"\((?P<file>[^()]+?):(?P<line>\d+):(?P<col>\d+)\)|at (?P<file2>[^\s()]+?):(?P<line2>\d+):(?P<col2>\d+)")


@dataclass
class Problem:
    file: str
    line: int
    col: int
    severity: str  # error | warning | info
    message: str
    source: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


def _rel(path: str, workdir: str) -> str | None:
    """Project-relative path, or None when the path is outside the project."""
    if path.startswith(workdir.rstrip("/") + "/"):
        rel = path[len(workdir.rstrip("/")) + 1 :]
    elif path.startswith("/"):
        return None
    else:
        rel = path[2:] if path.startswith("./") else path
    if any(seg in (".venv", "node_modules", ".compieler") for seg in rel.split("/")):
        return None
    return rel


def parse_gcc(text: str, workdir: str) -> list[Problem]:
    out: list[Problem] = []
    for raw in ANSI.sub("", text).splitlines():
        m = GCC.match(raw)
        if not m:
            continue
        rel = _rel(m["file"], workdir)
        if rel is None:
            continue
        sev = {"fatal error": "error", "error": "error", "warning": "warning", "note": "info"}[m["sev"]]
        out.append(Problem(rel, int(m["line"]), int(m["col"] or 1), sev, m["msg"], "g++"))
    return out


def parse_python(stderr: str, workdir: str) -> list[Problem]:
    lines = ANSI.sub("", stderr).splitlines()
    frame: tuple[str, int] | None = None
    for raw in lines:
        m = PY_FILE.match(raw)
        if m:
            rel = _rel(m["file"], workdir)
            if rel is not None:
                frame = (rel, int(m["line"]))
    if frame is None:
        return []
    msg = ""
    for raw in reversed(lines):
        m = PY_EXC.match(raw.strip())
        if m:
            msg = f'{m["name"]}: {m["msg"]}'.rstrip(": ")
            break
    if not msg:
        return []
    return [Problem(frame[0], frame[1], 1, "error", msg, "python")]


def parse_node(stderr: str, workdir: str) -> list[Problem]:
    lines = ANSI.sub("", stderr).splitlines()
    loc: tuple[str, int] | None = None
    msg = ""
    for raw in lines:
        m = NODE_LOC.match(raw.strip())
        if m and loc is None:
            rel = _rel(m["file"], workdir)
            if rel is not None:
                loc = (rel, int(m["line"]))
        m = NODE_EXC.match(raw.strip())
        if m and not msg:
            msg = f'{m["name"]}: {m["msg"]}'
    if loc is None:
        for raw in lines:  # fall back to the first stack frame inside the project
            m = NODE_AT.search(raw)
            if m:
                rel = _rel(m["file"] or m["file2"], workdir)
                if rel is not None:
                    loc = (rel, int(m["line"] or m["line2"]))
                    break
    if loc is None or not msg:
        return []
    return [Problem(loc[0], loc[1], 1, "error", msg, "node")]


MODULE_MISSING = re.compile(r"ModuleNotFoundError: No module named '([^'.]+)")
NODE_MISSING = re.compile(r"Cannot find module '([^'./][^']*)'")


def hints_for(language: str, stderr: str, phase: str, exit_reason: str) -> list[str]:
    """Plain-language explanations for the most common failures."""
    hints: list[str] = []
    text = ANSI.sub("", stderr)
    if language == "python":
        m = MODULE_MISSING.search(text)
        if m:
            hints.append(
                f"Module '{m.group(1)}' is not installed. Add it to requirements.txt or install it "
                f"from the Packages panel (or run `pip install {m.group(1)}` in the Terminal)."
            )
    if language == "javascript":
        m = NODE_MISSING.search(text)
        if m:
            hints.append(
                f"Package '{m.group(1)}' is not installed. Add it to package.json or install it from "
                f"the Packages panel (or run `npm install {m.group(1)}` in the Terminal)."
            )
    if phase == "install":
        if "No matching distribution found" in text or "Could not find a version that satisfies" in text:
            hints.append("pip could not find a matching release. Check the package name/version and that it supports this Python version.")
        if re.search(r"fatal error: [\w./+-]+\.h: No such file", text) or "Failed building wheel" in text or "error: command 'gcc' failed" in text:
            hints.append("The package must be compiled and needs system libraries that are missing in the runner image; prefer a version that ships a prebuilt wheel.")
        if "E404" in text or "404 Not Found" in text:
            hints.append("npm could not find that package or version.")
        if re.search(r"Temporary failure in name resolution|Connection refused|ENOTFOUND|Network is unreachable|timed out", text, re.I):
            hints.append("The package index is not reachable from the sandbox (network disabled or offline).")
    return hints
