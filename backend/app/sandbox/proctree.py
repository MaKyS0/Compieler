"""Process-tree helpers (descendants, RSS, kill, task counts).

Uses ``psutil`` when installed and falls back to reading ``/proc`` otherwise, so the
backend also runs where psutil cannot be built (Termux/Android, minimal containers).
"""
from __future__ import annotations

import os
import signal

try:
    import psutil
except ImportError:  # pragma: no cover - exercised through the forced fallback in tests
    psutil = None  # type: ignore[assignment]

_PAGE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096
use_psutil = psutil is not None


def _read_stat(pid: int) -> tuple[int, int] | None:
    """(ppid, rss_pages) from /proc/<pid>/stat, or None if the process is gone/unreadable."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            data = f.read().decode("utf-8", "replace")
    except OSError:
        return None
    # comm may contain spaces/parentheses: split after the last ')'
    rest = data[data.rfind(")") + 2 :].split()
    try:
        return int(rest[1]), int(rest[21])  # ppid is field 4, rss is field 24 (0-based 1 and 21 after comm/state)
    except (IndexError, ValueError):
        return None


def _all_pids() -> list[int]:
    try:
        return [int(n) for n in os.listdir("/proc") if n.isdigit()]
    except OSError:
        return []


def descendants(pid: int) -> list[int]:
    """``pid`` and all of its descendants."""
    if use_psutil:
        try:
            root = psutil.Process(pid)
            return [pid, *(p.pid for p in root.children(recursive=True))]
        except psutil.Error:
            return []
    children: dict[int, list[int]] = {}
    for p in _all_pids():
        st = _read_stat(p)
        if st:
            children.setdefault(st[0], []).append(p)
    out, queue = [], [pid]
    while queue:
        cur = queue.pop()
        out.append(cur)
        queue.extend(children.get(cur, []))
    return out if _read_stat(pid) else []


def rss_bytes(pids: list[int]) -> int:
    total = 0
    for pid in pids:
        if use_psutil:
            try:
                total += psutil.Process(pid).memory_info().rss
            except psutil.Error:
                pass
        else:
            st = _read_stat(pid)
            if st:
                total += st[1] * _PAGE
    return total


def kill_pids(pids: list[int]) -> None:
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def own_task_count(uid: int) -> int:
    """Number of threads owned by ``uid`` (RLIMIT_NPROC counts every task of the user)."""
    total = 0
    if use_psutil:
        for p in psutil.process_iter(["uids", "num_threads"]):
            try:
                if p.info["uids"].real == uid:
                    total += p.info["num_threads"]
            except (psutil.Error, AttributeError, TypeError):
                continue
        return total
    for pid in _all_pids():
        try:
            if os.stat(f"/proc/{pid}").st_uid == uid:
                total += max(1, len(os.listdir(f"/proc/{pid}/task")))
        except OSError:
            continue
    return total
