from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import owned_project, project_fs
from ..models import Project
from ..schemas import FileWrite, MoveBody, PathBody, TreeEntry
from ..services.projectfs import FSError, ProjectFS

router = APIRouter(prefix="/projects/{project_id}", tags=["files"])


def _http(e: FSError) -> HTTPException:
    return HTTPException(e.status, e.message)


async def _quota(request: Request, fs: ProjectFS, path: str, new_size: int) -> None:
    s = request.app.state.settings
    total, count = await asyncio.to_thread(fs.usage)
    existing = fs.exists(path)
    if existing is None and count >= s.max_files_per_project:
        raise HTTPException(413, f"Too many files (limit {s.max_files_per_project})")
    old = 0
    if existing == "file":
        try:
            old = len(await asyncio.to_thread(fs.read, path))
        except FSError:
            old = 0
    if total - old + new_size > s.max_project_bytes:
        raise HTTPException(413, "Project size limit exceeded")


async def _touch(session: AsyncSession, project: Project) -> None:
    project.updated_at = datetime.now(timezone.utc)
    await session.commit()


@router.get("/tree", response_model=list[TreeEntry])
async def tree(request: Request, project: Project = Depends(owned_project)):
    fs = project_fs(request, project)
    try:
        entries = await asyncio.to_thread(fs.tree)
    except FileNotFoundError:
        fs.ensure_root()
        entries = []
    return [TreeEntry(path=e.path, type=e.type, size=e.size) for e in entries]


@router.get("/file")
async def read_file(path: str, request: Request, project: Project = Depends(owned_project)):
    fs = project_fs(request, project)
    try:
        data = await asyncio.to_thread(fs.read, path, request.app.state.settings.max_edit_file_bytes)
    except FSError as e:
        raise _http(e) from None
    try:
        text = data.decode("utf-8")
        if "\x00" in text:
            raise UnicodeDecodeError("utf-8", b"", 0, 1, "nul")
    except UnicodeDecodeError:
        return {"path": path, "binary": True, "size": len(data), "content": ""}
    return {"path": path, "binary": False, "size": len(data), "content": text}


@router.put("/file", status_code=204)
async def write_file(
    body: FileWrite, request: Request, project: Project = Depends(owned_project), session: AsyncSession = Depends(get_session)
):
    s = request.app.state.settings
    data = body.content.encode("utf-8")
    if len(data) > s.max_edit_file_bytes:
        raise HTTPException(413, "File is too large")
    fs = project_fs(request, project)
    try:
        await _quota(request, fs, body.path, len(data))
        await asyncio.to_thread(fs.write, body.path, data)
    except FSError as e:
        raise _http(e) from None
    await _touch(session, project)


@router.post("/upload", status_code=201)
async def upload(
    request: Request,
    file: UploadFile = File(...),
    path: str = Form(...),
    project: Project = Depends(owned_project),
    session: AsyncSession = Depends(get_session),
):
    s = request.app.state.settings
    data = await file.read(s.max_upload_bytes + 1)
    if len(data) > s.max_upload_bytes:
        raise HTTPException(413, "File is too large")
    fs = project_fs(request, project)
    try:
        await _quota(request, fs, path, len(data))
        await asyncio.to_thread(fs.write, path, data)
    except FSError as e:
        raise _http(e) from None
    await _touch(session, project)
    return {"path": path, "size": len(data)}


@router.post("/dir", status_code=201)
async def make_dir(
    body: PathBody, request: Request, project: Project = Depends(owned_project), session: AsyncSession = Depends(get_session)
):
    fs = project_fs(request, project)
    try:
        await asyncio.to_thread(fs.mkdir, body.path)
    except FSError as e:
        raise _http(e) from None
    await _touch(session, project)
    return {"path": body.path}


@router.post("/move", status_code=204)
async def move(
    body: MoveBody, request: Request, project: Project = Depends(owned_project), session: AsyncSession = Depends(get_session)
):
    fs = project_fs(request, project)
    try:
        await asyncio.to_thread(fs.rename, body.src, body.dst)
    except FSError as e:
        raise _http(e) from None
    entry = project.settings.get("entry")
    if entry and (entry == body.src or entry.startswith(body.src + "/")):  # keep the run target in sync
        project.settings = {**project.settings, "entry": body.dst + entry[len(body.src):]}
    await _touch(session, project)


@router.delete("/file", status_code=204)
async def delete(
    path: str, request: Request, project: Project = Depends(owned_project), session: AsyncSession = Depends(get_session)
):
    fs = project_fs(request, project)
    try:
        await asyncio.to_thread(fs.delete, path)
    except FSError as e:
        raise _http(e) from None
    await _touch(session, project)
