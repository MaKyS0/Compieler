"""Code formatting through the standard tool of each language.

The formatters only parse text; they never execute user code. They run with a clean
environment in an empty temp directory so project-level config files (which for
prettier could be executable JS) are never picked up.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import tempfile


class FormatError(Exception):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.message, self.status = message, status


def _commands(language: str, filename: str | None) -> list[list[str]]:
    if language == "python":
        cmds = []
        if shutil.which("black"):
            cmds.append(["black", "-q", "--line-length", "100", "-"])
        if shutil.which("ruff"):
            cmds.append(["ruff", "format", "--stdin-filename", filename or "main.py", "-"])
        return cmds
    if language == "cpp":
        style = "{BasedOnStyle: LLVM, IndentWidth: 4, ColumnLimit: 100, AllowShortFunctionsOnASingleLine: Empty}"
        if shutil.which("clang-format"):
            return [["clang-format", f"--assume-filename={filename or 'main.cpp'}", f"--style={style}"]]
        return []
    if language == "javascript":
        if shutil.which("prettier"):
            return [["prettier", "--stdin-filepath", filename or "index.js", "--no-config", "--no-editorconfig", "--tab-width", "2"]]
    return []


def available() -> dict[str, bool]:
    return {lang: bool(_commands(lang, None)) for lang in ("python", "cpp", "javascript")}


async def format_code(language: str, content: str, filename: str | None = None) -> str:
    cmds = _commands(language, filename)
    if not cmds:
        raise FormatError(f"No formatter is installed on the server for {language}", 501)
    last_err = ""
    with tempfile.TemporaryDirectory() as tmp:
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": tmp, "LANG": "C.UTF-8"}
        for cmd in cmds:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd, cwd=tmp, env=env,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                )
                out, err = await asyncio.wait_for(proc.communicate(content.encode()), 15)
            except asyncio.TimeoutError:
                proc.kill()
                raise FormatError("The formatter timed out", 504) from None
            if proc.returncode == 0:
                return out.decode("utf-8", "replace")
            last_err = err.decode("utf-8", "replace").strip()
    msg = last_err.splitlines()[0] if last_err else "The code has syntax errors and cannot be formatted"
    raise FormatError(f"Cannot format: {msg}")
