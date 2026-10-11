"""WebSocket endpoint: interactive run / terminal / package installation.

Protocol (JSON text frames)

client -> server
  {"type":"auth","token":"..."}                       first message, within 5 s
  {"type":"run","entry":"main.py","args":"..","stdin":"..","std":"c++20","opt":"-O2","timeout":30,"network":false}
  {"type":"shell","command":"pip list"}
  {"type":"install","packages":["requests"]}
  {"type":"stdin","data":"text"}   {"type":"eof"}   {"type":"stop"}   {"type":"ping"}

server -> client
  {"type":"ready","sandbox":{...}}
  {"type":"start","kind":"run|shell|install"}
  {"type":"status","state":"queued"}
  {"type":"output","phase":"install|compile|run|shell|system","stream":"stdout|stderr|system","data":".."}
  {"type":"problems","items":[{file,line,col,severity,message,source}]}
  {"type":"exit","kind","phase","code","signal","reason","duration_ms","detail"}
  {"type":"error","code":"busy|rate_limited|bad_request","message":".."}
  {"type":"pong"}
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from ..db import session_factory
from ..models import Project, User
from ..runner.manager import Busy
from ..runner.session import JobSession, ProjectCtx
from ..security import decode_token
from ..services.projectfs import ProjectFS

log = logging.getLogger("compieler.ws")
router = APIRouter()

MAX_FRAME = 256 * 1024
FLUSH_INTERVAL = 0.025
FLUSH_BYTES = 32 * 1024


class Outbox:
    """Coalesces tiny output chunks into fewer frames; applies natural backpressure."""

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.closed = False
        self._lock = asyncio.Lock()
        self._key: tuple[str, str] | None = None
        self._parts: list[str] = []
        self._size = 0
        self._timer: asyncio.Task | None = None

    async def emit(self, ev: dict) -> None:
        if self.closed:
            return
        async with self._lock:
            if ev["type"] == "output":
                key = (ev["phase"], ev["stream"])
                if self._key != key:
                    await self._flush()
                    self._key = key
                self._parts.append(ev["data"])
                self._size += len(ev["data"])
                if self._size >= FLUSH_BYTES:
                    await self._flush()
                elif self._timer is None:
                    self._timer = asyncio.create_task(self._delayed())
            else:
                await self._flush()
                await self._send(ev)

    async def _delayed(self) -> None:
        await asyncio.sleep(FLUSH_INTERVAL)
        async with self._lock:
            self._timer = None
            await self._flush()

    async def _flush(self) -> None:
        if self._key and self._parts:
            phase, stream = self._key
            data = "".join(self._parts)
            self._parts, self._size = [], 0
            await self._send({"type": "output", "phase": phase, "stream": stream, "data": data})

    async def _send(self, ev: dict) -> None:
        if self.closed:
            return
        try:
            await self.ws.send_text(json.dumps(ev))
        except Exception:  # connection is gone
            self.closed = True

    async def close(self) -> None:
        self.closed = True
        if self._timer:
            self._timer.cancel()


async def _authenticate(ws: WebSocket, project_id: int) -> tuple[User, Project] | None:
    try:
        first = await asyncio.wait_for(ws.receive_text(), timeout=5)
        msg = json.loads(first)
    except Exception:
        await ws.close(4401)
        return None
    uid = decode_token(msg.get("token", "")) if msg.get("type") == "auth" else None
    if uid is None:
        await ws.close(4401)
        return None
    async with session_factory()() as db:
        user = await db.get(User, uid)
        project = await db.get(Project, project_id)
    if user is None or project is None or project.owner_id != user.id:
        await ws.close(4404)  # same answer for "missing" and "not yours"
        return None
    return user, project


@router.websocket("/ws/projects/{project_id}")
async def project_socket(ws: WebSocket, project_id: int):
    await ws.accept()
    auth = await _authenticate(ws, project_id)
    if auth is None:
        return
    user, _ = auth
    app = ws.app
    settings, sandbox, manager, limiter = app.state.settings, app.state.sandbox, app.state.run_manager, app.state.limiter
    out = Outbox(ws)
    await out.emit({"type": "ready", "sandbox": sandbox.describe()})

    session: JobSession | None = None
    task: asyncio.Task | None = None

    async def start_job(kind: str, msg: dict) -> None:
        nonlocal session, task
        if task is not None and not task.done():
            await out.emit({"type": "error", "code": "busy", "message": "A program is already running."})
            return
        if not limiter.allow(("run", user.id), settings.runs_per_minute, 60):
            await out.emit({"type": "error", "code": "rate_limited", "message": "Too many runs per minute. Please slow down."})
            return
        async with session_factory()() as db:
            project = await db.get(Project, project_id)
        if project is None or project.owner_id != user.id:
            await out.emit({"type": "error", "code": "bad_request", "message": "Project no longer exists."})
            return
        fs = ProjectFS(settings.projects_dir / str(project.id), sandbox.project_uid(project.id))
        fs.ensure_root()
        session = JobSession(sandbox, settings, ProjectCtx(project.id, project.language, dict(project.settings), fs), out.emit)
        current = session

        async def runner() -> None:
            try:
                async with manager.slot(user.id, lambda: out.emit({"type": "status", "state": "queued"})):
                    manager.sessions.add(current)
                    try:
                        if kind == "run":
                            await current.run(msg)
                        elif kind == "shell":
                            await current.shell(str(msg.get("command", "")))
                        else:
                            pk = msg.get("packages") or []
                            await current.install([str(p) for p in pk] if isinstance(pk, list) else [])
                    finally:
                        manager.sessions.discard(current)
            except Busy as e:
                await out.emit({"type": "error", "code": "busy", "message": str(e)})
            except Exception:
                log.exception("job crashed")
                await out.emit({"type": "error", "code": "internal", "message": "Internal error"})

        task = asyncio.create_task(runner())

    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > MAX_FRAME:
                await out.emit({"type": "error", "code": "bad_request", "message": "Message too large"})
                continue
            try:
                msg = json.loads(raw)
                kind = msg["type"]
            except (ValueError, KeyError, TypeError):
                await out.emit({"type": "error", "code": "bad_request", "message": "Malformed message"})
                continue
            if kind in ("run", "shell", "install"):
                await start_job(kind, msg)
            elif kind == "stdin" and session is not None:
                await session.send_stdin(str(msg.get("data", "")))
            elif kind == "eof" and session is not None:
                await session.close_stdin()
            elif kind == "stop" and session is not None:
                await session.stop()
            elif kind == "ping":
                await out.emit({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("websocket error")
    finally:
        # Never leave a program running for a client that is gone.
        await out.close()
        if session is not None:
            await session.stop()
        if task is not None:
            try:
                await asyncio.wait_for(task, timeout=15)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                task.cancel()
        if ws.application_state != WebSocketState.DISCONNECTED:
            try:
                await ws.close()
            except Exception:
                pass
