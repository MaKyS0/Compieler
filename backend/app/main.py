from __future__ import annotations

import asyncio
import logging
import shutil
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from . import db
from .api import auth, files, meta, projects, ws
from .config import get_settings
from .models import Project, User
from .ratelimit import RateLimiter
from .runner.manager import RunManager
from .sandbox.factory import create_sandbox
from .services.projectfs import FSError, ProjectFS

log = logging.getLogger("compieler")


def setup_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


async def _gc_loop(app: FastAPI) -> None:
    """Delete long-unused guest accounts together with their project files."""
    s = app.state.settings
    while True:
        try:
            cutoff = datetime.now(timezone.utc) - timedelta(days=s.guest_ttl_days)
            async with db.session_factory()() as session:
                stale = (await session.scalars(select(User).where(User.is_guest.is_(True), User.last_seen < cutoff))).all()
                for user in stale:
                    for p in (await session.scalars(select(Project).where(Project.owner_id == user.id))).all():
                        await asyncio.to_thread(shutil.rmtree, s.projects_dir / str(p.id), True)
                    await session.delete(user)
                await session.commit()
            # leftovers of runs that were killed with the server
            for d in s.tmp_dir.glob("run-*"):
                if datetime.now().timestamp() - d.stat().st_mtime > 3600:
                    await asyncio.to_thread(shutil.rmtree, d, True)
        except Exception:
            log.exception("gc failed")
        await asyncio.sleep(3600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    s = get_settings()
    app.state.settings = s
    db.init_engine()
    await db.create_all()
    app.state.sandbox = await create_sandbox(s)
    app.state.run_manager = RunManager(s)
    app.state.limiter = RateLimiter()
    gc = asyncio.create_task(_gc_loop(app))
    try:
        yield
    finally:
        gc.cancel()
        await app.state.run_manager.shutdown()
        await db.dispose()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="Compieler", version="1.0.0", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
    if s.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=s.cors_origins, allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(FSError)
    async def _fs_error(_: Request, exc: FSError):
        return JSONResponse({"detail": exc.message}, status_code=exc.status)

    @app.middleware("http")
    async def _security_headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        return resp

    for r in (auth.router, projects.router, files.router, meta.router):
        app.include_router(r, prefix="/api")
    app.include_router(ws.router, prefix="/api")

    static = s.static_dir
    if static and Path(static).is_dir():
        index = Path(static) / "index.html"
        app.mount("/assets", StaticFiles(directory=Path(static) / "assets"), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa(full_path: str):
            if full_path.startswith("api/"):
                return JSONResponse({"detail": "Not found"}, status_code=404)
            candidate = (Path(static) / full_path).resolve()
            if full_path and candidate.is_file() and Path(static).resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(index)

    return app


app = create_app()
