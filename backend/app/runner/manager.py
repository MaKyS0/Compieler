"""Global and per-user concurrency control for sandboxed jobs."""
from __future__ import annotations

import asyncio
from collections import Counter
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager

from ..config import Settings


class Busy(Exception):
    pass


class RunManager:
    def __init__(self, settings: Settings):
        self.s = settings
        self._sem = asyncio.Semaphore(settings.max_concurrent_runs)
        self._active: Counter[int] = Counter()
        self.sessions: set = set()  # live JobSessions, stopped on shutdown

    @property
    def running(self) -> int:
        return sum(self._active.values())

    @asynccontextmanager
    async def slot(self, user_id: int, on_wait: Callable[[], Awaitable[None]]):
        if self._active[user_id] >= self.s.max_runs_per_user:
            raise Busy(f"You already have {self.s.max_runs_per_user} programs running. Stop one first.")
        self._active[user_id] += 1
        acquired = False
        try:
            if self._sem.locked():
                await on_wait()
            try:
                await asyncio.wait_for(self._sem.acquire(), timeout=30)
            except asyncio.TimeoutError:
                raise Busy("The server is busy right now. Please try again in a moment.") from None
            acquired = True
            yield
        finally:
            if acquired:
                self._sem.release()
            self._active[user_id] -= 1
            if self._active[user_id] <= 0:
                del self._active[user_id]

    async def shutdown(self) -> None:
        await asyncio.gather(*(s.stop() for s in list(self.sessions)), return_exceptions=True)
