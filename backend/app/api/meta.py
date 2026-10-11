from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from ..deps import current_user
from ..models import User
from ..schemas import FormatBody
from ..services import formatter

router = APIRouter(tags=["meta"])


@router.get("/health")
async def health(request: Request):
    return {"status": "ok", "sandbox": request.app.state.sandbox.describe()}


@router.get("/config")
async def config(request: Request):
    s = request.app.state.settings
    return {
        "languages": ["python", "cpp", "javascript"],
        "cpp_standards": ["c++17", "c++20", "c++23"],
        "formatters": formatter.available(),
        "limits": {
            "run_wall_seconds": s.run_wall_seconds,
            "run_cpu_seconds": s.run_cpu_seconds,
            "memory_mb": s.memory_mb,
            "max_processes": s.max_processes,
            "max_output_bytes": s.max_output_bytes,
            "max_project_bytes": s.max_project_bytes,
            "max_upload_bytes": s.max_upload_bytes,
        },
        "allow_runtime_network": s.allow_runtime_network,
        "allow_registration": s.allow_registration,
        "sandbox": request.app.state.sandbox.describe(),
    }


@router.post("/format")
async def format_code(body: FormatBody, request: Request, user: User = Depends(current_user)):
    if not request.app.state.limiter.allow(("format", user.id), 60, 60):
        raise HTTPException(429, "Too many format requests")
    try:
        return {"content": await formatter.format_code(body.language, body.content, body.filename)}
    except formatter.FormatError as e:
        raise HTTPException(e.status, e.message) from None
