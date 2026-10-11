"""Symlink-safe file operations inside one project directory.

The sandboxed program owns (and can freely modify) its project directory, so the
privileged backend must treat everything in there as hostile: a program can leave
symlinks to /etc/shadow, FIFOs that block ``open()``, or swap a directory for a link
between our check and our use. Every operation therefore walks the path component by
component with ``O_NOFOLLOW`` relative to a directory fd and refuses anything that is
not a plain file or directory.
"""
from __future__ import annotations

import os
import secrets
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path

# Directories that belong to the runtime, not to the user's source tree.
HIDDEN_NAMES = frozenset({".venv", "node_modules", ".compieler", "__pycache__", ".cache", ".npm"})
MAX_PATH_LEN = 400
MAX_NAME_LEN = 200
MAX_DEPTH = 24


class FSError(Exception):
    """Raised for invalid or unsafe file operations; carries an HTTP-ish status."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


@dataclass
class Entry:
    path: str
    type: str  # "file" | "dir"
    size: int = 0


def split_path(rel: str, *, allow_hidden: bool = False) -> list[str]:
    """Validate a user supplied relative path and return its components."""
    if not isinstance(rel, str) or not rel:
        raise FSError("Path is empty")
    if len(rel) > MAX_PATH_LEN:
        raise FSError("Path is too long")
    if "\x00" in rel or "\\" in rel:
        raise FSError("Path contains illegal characters")
    if rel.startswith("/"):
        raise FSError("Absolute paths are not allowed")
    parts = rel.split("/")
    if parts and parts[-1] == "":
        parts.pop()  # tolerate a trailing slash
    if not parts or len(parts) > MAX_DEPTH:
        raise FSError("Invalid path")
    for p in parts:
        if p in ("", ".", "..") or len(p) > MAX_NAME_LEN:
            raise FSError("Invalid path component")
        if any(ord(c) < 32 for c in p):
            raise FSError("Path contains control characters")
        if not allow_hidden and p in HIDDEN_NAMES:
            raise FSError(f"'{p}' is managed by the runtime and cannot be edited directly")
    return parts


class ProjectFS:
    def __init__(self, root: Path, uid: int | None = None):
        self.root = root
        self.uid = uid

    # ------------------------------------------------------------------ setup
    def _chown(self, fd_or_path, *, dir_fd: int | None = None) -> None:
        if self.uid is None or os.geteuid() != 0:
            return
        if isinstance(fd_or_path, int):
            os.fchown(fd_or_path, self.uid, self.uid)
        else:
            os.chown(fd_or_path, self.uid, self.uid, dir_fd=dir_fd, follow_symlinks=False)

    def ensure_root(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        self._chown(str(self.root))

    def _root_fd(self) -> int:
        return os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def _walk_dirs(self, parts: list[str], *, create: bool = False) -> int:
        """Open the directory ``parts`` (may be empty) and return its fd."""
        fd = self._root_fd()
        try:
            for name in parts:
                try:
                    nxt = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                except FileNotFoundError:
                    if not create:
                        raise FSError("Not found", 404) from None
                    os.mkdir(name, 0o755, dir_fd=fd)
                    self._chown(name, dir_fd=fd)
                    nxt = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                except (NotADirectoryError, OSError) as e:
                    raise FSError("Path crosses a file or link", 400) from e
                os.close(fd)
                fd = nxt
            return fd
        except BaseException:
            os.close(fd)
            raise

    # ------------------------------------------------------------------ queries
    def tree(self, max_entries: int = 5000) -> list[Entry]:
        out: list[Entry] = []

        def rec(dir_fd: int, prefix: str) -> None:
            with os.scandir(dir_fd) as it:
                items = sorted(it, key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower()))
                for e in items:
                    if e.name in HIDDEN_NAMES or len(out) >= max_entries:
                        continue
                    rel = f"{prefix}{e.name}"
                    try:
                        st = e.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if stat.S_ISDIR(st.st_mode):
                        out.append(Entry(rel, "dir"))
                        try:
                            sub = os.open(e.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
                        except OSError:
                            continue
                        try:
                            rec(sub, rel + "/")
                        finally:
                            os.close(sub)
                    elif stat.S_ISREG(st.st_mode):
                        out.append(Entry(rel, "file", st.st_size))

        fd = self._root_fd()
        try:
            rec(fd, "")
        finally:
            os.close(fd)
        return out

    def usage(self) -> tuple[int, int]:
        """(total bytes, number of entries) of user-visible content."""
        entries = self.tree(max_entries=100_000)
        return sum(e.size for e in entries), len(entries)

    def read(self, rel: str, max_bytes: int | None = None, *, allow_hidden: bool = False) -> bytes:
        parts = split_path(rel, allow_hidden=allow_hidden)
        dfd = self._walk_dirs(parts[:-1])
        try:
            try:
                fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)
            except FileNotFoundError:
                raise FSError("File not found", 404) from None
            except OSError as e:
                raise FSError("Cannot open file", 400) from e
            try:
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode):
                    raise FSError("Not a regular file", 400)
                if max_bytes is not None and st.st_size > max_bytes:
                    raise FSError("File is too large to open in the editor", 413)
                with os.fdopen(fd, "rb", closefd=False) as f:
                    return f.read()
            finally:
                os.close(fd)
        finally:
            os.close(dfd)

    def exists(self, rel: str) -> str | None:
        """Return 'file', 'dir' or None."""
        try:
            parts = split_path(rel, allow_hidden=True)
            dfd = self._walk_dirs(parts[:-1])
        except FSError:
            return None
        try:
            st = os.stat(parts[-1], dir_fd=dfd, follow_symlinks=False)
        except OSError:
            return None
        finally:
            os.close(dfd)
        return "dir" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else None

    # ------------------------------------------------------------------ mutations
    def write(self, rel: str, data: bytes, *, allow_hidden: bool = False) -> None:
        parts = split_path(rel, allow_hidden=allow_hidden)
        dfd = self._walk_dirs(parts[:-1], create=True)
        name = parts[-1]
        tmp = f".{name[:60]}.{secrets.token_hex(4)}.tmp"
        try:
            try:
                st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
                if stat.S_ISDIR(st.st_mode):
                    raise FSError("A directory with this name already exists", 409)
                mode = stat.S_IMODE(st.st_mode) if stat.S_ISREG(st.st_mode) else 0o644
            except FileNotFoundError:
                mode = 0o644
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
            try:
                view = memoryview(data)
                while view:
                    n = os.write(fd, view)
                    view = view[n:]
                os.fchmod(fd, mode)
                self._chown(fd)
            finally:
                os.close(fd)
            os.replace(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
        except BaseException:
            try:
                os.unlink(tmp, dir_fd=dfd)
            except OSError:
                pass
            raise
        finally:
            os.close(dfd)

    def mkdir(self, rel: str) -> None:
        parts = split_path(rel)
        fd = self._walk_dirs(parts, create=True)
        os.close(fd)

    def delete(self, rel: str) -> None:
        parts = split_path(rel)
        dfd = self._walk_dirs(parts[:-1])
        try:
            try:
                st = os.stat(parts[-1], dir_fd=dfd, follow_symlinks=False)
            except FileNotFoundError:
                raise FSError("Not found", 404) from None
            if stat.S_ISDIR(st.st_mode):
                # fd-relative rmtree: never follows links, immune to path swaps.
                shutil.rmtree(parts[-1], dir_fd=dfd)
            else:
                os.unlink(parts[-1], dir_fd=dfd)
        finally:
            os.close(dfd)

    def rename(self, src: str, dst: str) -> None:
        sp, dp = split_path(src), split_path(dst)
        if dp[: len(sp)] == sp:
            raise FSError("Cannot move a folder into itself")
        sfd = self._walk_dirs(sp[:-1])
        try:
            dfd = self._walk_dirs(dp[:-1], create=True)
            try:
                try:
                    os.stat(sp[-1], dir_fd=sfd, follow_symlinks=False)
                except FileNotFoundError:
                    raise FSError("Not found", 404) from None
                try:
                    os.stat(dp[-1], dir_fd=dfd, follow_symlinks=False)
                    raise FSError("Destination already exists", 409)
                except FileNotFoundError:
                    pass
                os.rename(sp[-1], dp[-1], src_dir_fd=sfd, dst_dir_fd=dfd)
            finally:
                os.close(dfd)
        finally:
            os.close(sfd)

    def wipe(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    # ------------------------------------------------------------------ bulk
    def iter_files(self):
        """Yield (relative path, bytes) of user visible regular files (for export)."""
        for e in self.tree(max_entries=100_000):
            if e.type == "file":
                try:
                    yield e.path, self.read(e.path)
                except FSError:
                    continue
