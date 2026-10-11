"""Sandbox abstraction + process supervision shared by all backends.

A *sandbox* knows how to start one untrusted command in isolation. Everything
backend-independent - streaming output with a hard cap, wall-clock deadline, memory
watchdog, stdin plumbing, kill-once semantics - lives in :class:`ManagedProcess`.
"""
from __future__ import annotations

import asyncio
import codecs
import logging
import signal
import time
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("compieler.sandbox")

OutputCallback = Callable[[str, str], Awaitable[None]]  # (stream, text)


@dataclass(frozen=True)
class Limits:
    wall_s: float
    cpu_s: float
    memory_mb: int
    nproc: int
    fsize_mb: int
    nofile: int
    output_bytes: int
    # RLIMIT_AS multiplier on memory_mb. None disables (needed for V8 / JVM style runtimes).
    vm_factor: float | None = None


@dataclass
class ExecRequest:
    project_id: int
    project_dir: Path
    argv: list[str]
    env: dict[str, str]
    limits: Limits
    network: str = "none"  # none | install | full
    phase: str = "run"      # install | compile | run | shell
    label: str = ""


@dataclass
class ExecResult:
    exit_code: int | None
    signal: str | None
    reason: str  # ok | error | timeout | cpu_limit | memory | output_limit | stopped | signal | sandbox_error
    duration_ms: int
    detail: str = ""


class Sandbox(ABC):
    name: str = "base"
    # True when the backend reports "killed by signal N" as exit status 128+N (like a shell).
    signal_exit_codes: bool = False

    @abstractmethod
    def workdir(self, project_id: int, project_dir: Path) -> str:
        """Path of the project directory as seen *inside* the sandbox."""

    @abstractmethod
    def cache_path(self, project_id: int, project_dir: Path) -> str:
        """Writable package-cache directory as seen inside the sandbox."""

    @abstractmethod
    def default_path(self) -> str:
        """PATH for commands inside the sandbox."""

    @abstractmethod
    def project_uid(self, project_id: int) -> int | None:
        """Owner uid that project files must have so the sandbox can write them."""

    @abstractmethod
    async def spawn(self, req: ExecRequest) -> "SpawnedProcess":
        ...

    async def probe(self) -> dict:
        return {"backend": self.name}

    def describe(self) -> dict:
        return {"backend": self.name}


@dataclass
class SpawnedProcess:
    proc: asyncio.subprocess.Process
    cleanup: Callable[[], Awaitable[None]]
    kill: Callable[[], Awaitable[None]]
    # Optional: bytes of resident memory across the whole process tree.
    rss: Callable[[], int] | None = None
    # Optional: called after exit to learn whether the kernel OOM-killed the workload.
    was_oom_killed: Callable[[], Awaitable[bool]] | None = None
    extra: dict = field(default_factory=dict)


SIGNAL_NAMES = {s.value: s.name for s in signal.Signals}


class ManagedProcess:
    """Runs one :class:`ExecRequest` and supervises it until it ends."""

    def __init__(self, sandbox: Sandbox, req: ExecRequest, on_output: OutputCallback):
        self.sandbox = sandbox
        self.req = req
        self.on_output = on_output
        self._sp: SpawnedProcess | None = None
        self._reason: str | None = None
        self._detail = ""
        self._started = 0.0
        self._bytes = 0
        self._tasks: list[asyncio.Task] = []
        self._kill_lock = asyncio.Lock()
        self._killed = False
        self._stdin_closed = False

    # ------------------------------------------------------------------ control
    async def start(self) -> None:
        self._started = time.monotonic()
        self._sp = await self.sandbox.spawn(self.req)
        proc = self._sp.proc
        self._tasks = [
            asyncio.create_task(self._pump(proc.stdout, "stdout")),
            asyncio.create_task(self._pump(proc.stderr, "stderr")),
            asyncio.create_task(self._watchdog()),
        ]

    async def write_stdin(self, data: bytes) -> None:
        if not self._sp or self._stdin_closed:
            return
        stdin = self._sp.proc.stdin
        if stdin is None or stdin.is_closing():
            return
        try:
            stdin.write(data)
            await stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            self._stdin_closed = True

    async def close_stdin(self) -> None:
        if not self._sp or self._stdin_closed:
            return
        self._stdin_closed = True
        stdin = self._sp.proc.stdin
        if stdin is None:
            return
        try:
            if stdin.can_write_eof():
                stdin.write_eof()
            stdin.close()
            await stdin.wait_closed()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    async def stop(self, reason: str = "stopped", detail: str = "") -> None:
        await self._kill(reason, detail)

    async def _kill(self, reason: str, detail: str = "") -> None:
        async with self._kill_lock:
            if self._reason is None:
                self._reason = reason
                self._detail = detail
            if self._killed or self._sp is None:
                return
            self._killed = True
            try:
                await self._sp.kill()
            except Exception:  # pragma: no cover - best effort
                log.exception("kill failed")

    async def _kill_stragglers(self) -> None:
        if self._sp is not None and not self._killed:
            self._killed = True
            try:
                await self._sp.kill()
            except Exception:  # pragma: no cover
                log.exception("straggler kill failed")

    # ------------------------------------------------------------------ internals
    async def _pump(self, stream: asyncio.StreamReader | None, name: str) -> None:
        if stream is None:
            return
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        limit = self.req.limits.output_bytes
        while True:
            try:
                chunk = await stream.read(65536)
            except (ConnectionResetError, asyncio.IncompleteReadError):
                break
            if not chunk:
                break
            remaining = limit - self._bytes
            if remaining <= 0:
                continue  # already over the cap; drain so the process can die
            if len(chunk) > remaining:
                chunk = chunk[:remaining]
                self._bytes = limit
                text = decoder.decode(chunk)
                if text:
                    await self.on_output(name, text)
                await self._kill("output_limit", f"Output exceeded {limit} bytes")
                continue
            self._bytes += len(chunk)
            text = decoder.decode(chunk)
            if text:
                await self.on_output(name, text)
        tail = decoder.decode(b"", final=True)
        if tail:
            await self.on_output(name, tail)

    async def _watchdog(self) -> None:
        assert self._sp is not None
        lim = self.req.limits
        mem_cap = lim.memory_mb * 1024 * 1024
        deadline = self._started + lim.wall_s
        while self._sp.proc.returncode is None:
            await asyncio.sleep(0.1)
            if time.monotonic() > deadline:
                await self._kill("timeout", f"Time limit of {lim.wall_s:g}s exceeded")
                return
            if self._sp.rss is not None:
                try:
                    used = await asyncio.to_thread(self._sp.rss)
                except Exception:
                    used = 0
                if used > mem_cap:
                    await self._kill("memory", f"Memory limit of {lim.memory_mb} MB exceeded")
                    return

    async def wait(self) -> ExecResult:
        assert self._sp is not None
        proc = self._sp.proc
        try:
            code = await proc.wait()
            # Drain what is left in the pipes. A background grandchild may keep them
            # open forever, so give up after a moment and kill whatever remains.
            drain = asyncio.gather(*self._tasks[:2], return_exceptions=True)
            try:
                await asyncio.wait_for(asyncio.shield(drain), timeout=1.0)
            except asyncio.TimeoutError:
                await self._kill_stragglers()
                await asyncio.wait_for(drain, timeout=2.0)
        finally:
            if self._reason is None and self._sp.was_oom_killed is not None:
                try:
                    if await self._sp.was_oom_killed():
                        self._reason, self._detail = "memory", f"Memory limit of {self.req.limits.memory_mb} MB exceeded"
                except Exception:
                    pass
            self._tasks[2].cancel()
            try:
                await self._sp.cleanup()
            except Exception:
                log.exception("sandbox cleanup failed")
        duration = int((time.monotonic() - self._started) * 1000)
        sig: str | None = None
        exit_code: int | None = code
        if code is not None and code < 0:
            sig, exit_code = SIGNAL_NAMES.get(-code, str(-code)), None
        elif code is not None and code > 128 and self.sandbox.signal_exit_codes:
            sig = SIGNAL_NAMES.get(code - 128)
            if sig is not None:
                exit_code = None
        reason = self._reason
        if reason is None:
            if sig == "SIGXCPU":
                reason, self._detail = "cpu_limit", f"CPU time limit of {self.req.limits.cpu_s:g}s exceeded"
            elif sig is not None:
                reason = "signal"
            else:
                reason = "ok" if code == 0 else "error"
        return ExecResult(exit_code, sig, reason, duration, self._detail)
