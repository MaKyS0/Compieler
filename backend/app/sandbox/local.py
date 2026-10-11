"""LocalSandbox: process-level isolation without containers (dev / CI / no-Docker hosts).

Isolation ladder, detected at start-up by actually trying each primitive:

* **L0** - rlimits + own process group + stripped environment. Code can still read
  anything the backend user can read and use the network. Refused in prod unless
  explicitly allowed.
* **L1** - L0 + ``unshare`` PID / network / IPC / UTS namespaces (needs CAP_SYS_ADMIN,
  i.e. root or a permissive container). No network, whole process tree dies with the
  namespace, other processes are invisible.
* **L1+uid** - when the backend is root every project runs as its own unprivileged uid
  (``sandbox_uid_base + project_id``) with a 0700 project directory, so projects cannot
  read each other's files or the backend's 0600 secrets.

There is no mount namespace pivot: world-readable host files stay readable.
Use DockerSandbox for real filesystem isolation.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import signal
import sys
import tempfile
from pathlib import Path

import psutil

from ..config import Settings
from .base import ExecRequest, Sandbox, SpawnedProcess

log = logging.getLogger("compieler.sandbox.local")
LAUNCHER = Path(__file__).with_name("launcher.py")


class LocalSandbox(Sandbox):
    name = "local"
    signal_exit_codes = False  # True once PID-namespace init reports 128+signal

    def __init__(self, settings: Settings):
        self.s = settings
        self.is_root = os.geteuid() == 0
        self.has_pidns = False
        self.has_netns = False
        self.level = "L0"
        self._path = "/usr/local/bin:/usr/bin:/bin"

    # ----------------------------------------------------------------- info
    def workdir(self, project_id: int, project_dir: Path) -> str:
        return str(project_dir)

    def project_uid(self, project_id: int) -> int | None:
        return self.s.sandbox_uid_base + project_id if self.is_root else None

    def cache_path(self, project_id: int, project_dir: Path) -> str:
        return str(project_dir / ".compieler" / "cache")

    def default_path(self) -> str:
        return self._path

    def describe(self) -> dict:
        return {
            "backend": self.name,
            "isolation": self.level,
            "network_namespace": self.has_netns,
            "pid_namespace": self.has_pidns,
            "per_project_uid": self.is_root,
        }

    async def probe(self) -> dict:
        async def ok(*args: str) -> bool:
            try:
                p = await asyncio.create_subprocess_exec(
                    *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
                )
                return await asyncio.wait_for(p.wait(), 5) == 0
            except (OSError, asyncio.TimeoutError):
                return False

        base = "/usr/local/bin:/usr/bin:/bin"
        extra: list[str] = []
        for tool in ("python3", "g++", "node", "npm", "bash"):
            if shutil.which(tool, path=base) is None:
                found = shutil.which(tool)
                if found:
                    extra.append(str(Path(found).parent))
        self._path = ":".join([*dict.fromkeys(extra), base])
        if shutil.which("unshare"):
            self.has_pidns = await ok("unshare", "--pid", "--fork", "--kill-child", "--mount-proc", "true")
            self.has_netns = await ok("unshare", "--net", "true")
        self.level = "L1" if (self.has_pidns and self.has_netns) else "L0"
        self.signal_exit_codes = self.has_pidns
        if self.level == "L0":
            log.warning(
                "LocalSandbox runs at isolation level L0 (no namespaces available): "
                "user code can reach the network and read world-readable host files"
            )
        if not self.is_root:
            log.warning("Backend is not root: all projects share one uid (no cross-project file isolation)")
        return self.describe()

    def _own_tasks(self) -> int:
        """RLIMIT_NPROC counts every task of the uid, so a shared uid needs headroom."""
        uid, total = os.geteuid(), 0
        for p in psutil.process_iter(["uids", "num_threads"]):
            try:
                if p.info["uids"].real == uid:
                    total += p.info["num_threads"]
            except (psutil.Error, AttributeError, TypeError):
                continue
        return total

    # ----------------------------------------------------------------- spawn
    async def spawn(self, req: ExecRequest) -> SpawnedProcess:
        lim = req.limits
        uid = self.project_uid(req.project_id)
        run_tmp = Path(tempfile.mkdtemp(prefix="run-", dir=self.s.tmp_dir))
        os.chmod(run_tmp, 0o700)
        if uid is not None:
            os.chown(run_tmp, uid, uid)
        env = dict(req.env)
        env.setdefault("HOME", str(run_tmp))
        env.setdefault("TMPDIR", str(run_tmp))

        launcher = [
            sys.executable, "-I", str(LAUNCHER),
            "--cwd", str(req.project_dir),
            "--cpu", str(max(1, int(lim.cpu_s))),
            "--fsize-mb", str(lim.fsize_mb),
            "--nofile", str(lim.nofile),
            "--nproc", str(lim.nproc + (0 if self.is_root else self._own_tasks())),
        ]
        if uid is not None:
            launcher += ["--uid", str(uid)]
        if self.has_pidns:
            launcher += ["--init"]
        if req.network == "none" and self.has_netns:
            launcher += ["--lo-up"]
        if lim.vm_factor:
            launcher += ["--as-mb", str(int(lim.memory_mb * lim.vm_factor))]
        launcher += ["--", *req.argv]

        wrapper: list[str] = []
        if self.has_pidns:
            wrapper = ["unshare", "--pid", "--fork", "--kill-child", "--mount-proc"]
            if req.network == "none" and self.has_netns:
                wrapper.append("--net")
            wrapper += ["--ipc", "--uts"]
        argv = [*wrapper, *launcher]

        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=str(self.s.tmp_dir),
            start_new_session=True,
            limit=1 << 20,
        )

        def tree() -> list[psutil.Process]:
            try:
                root = psutil.Process(proc.pid)
                return [root, *root.children(recursive=True)]
            except psutil.Error:
                return []

        def rss() -> int:
            total = 0
            for p in tree():
                try:
                    total += p.memory_info().rss
                except psutil.Error:
                    pass
            return total

        async def kill() -> None:
            victims = tree()
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            for p in victims:
                try:
                    p.kill()
                except psutil.Error:
                    pass

        async def cleanup() -> None:
            # Anything still alive in the group (L0 has no PID namespace) must die with the run.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            await asyncio.to_thread(shutil.rmtree, run_tmp, True)

        return SpawnedProcess(proc=proc, cleanup=cleanup, kill=kill, rss=rss)
