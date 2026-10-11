"""Small in-memory sliding-window rate limiter (single process)."""
from __future__ import annotations

import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[object, deque[float]] = defaultdict(deque)

    def allow(self, key: object, limit: int, window: float) -> bool:
        now = time.monotonic()
        q = self._hits[key]
        while q and now - q[0] > window:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        if len(self._hits) > 50_000:  # opportunistic GC of idle keys
            for k in [k for k, v in self._hits.items() if not v or now - v[-1] > window]:
                self._hits.pop(k, None)
        return True
