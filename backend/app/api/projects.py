from __future__ import annotations

import asyncio
import io
import re
import stat
import tempfile
import zipfile
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import current_user, owned_project, project_fs
from ..models import Project, User
from ..schemas import ProjectCreate, ProjectOut, ProjectPatch
from ..services.projectfs import HIDDEN_NAMES, FSError, ProjectFS, split_path
from ..services.templates import DEFAULT_ENTRY, TEMPLATES, detect_language

router = APIRouter(prefix="/projects", tags=["projects"])


async def _check_quota(session: AsyncSession, user: User, request: Request) -> None:
    n = await session.scalar(select(func.count()).select_from(Project).where(Project.owner_id == user.id))
    if (n or 0) >= request.app.state.settings.max_projects_per_user:
        raise HTTPException(409, "Project limit reached - delete an old project first")


async def _create(session: AsyncSession, request: Request, user: User, name: str, language: str) -> tuple[Project, ProjectFS]:
    await _check_quota(session, user, request)
    p = Project(owner_id=user.id, name=name, language=language, settings={})
    session.add(p)
    await session.commit()
    fs = project_fs(request, p)
    fs.wipe()  # ids can be reused after deletes; never inherit stale files
    fs.ensure_root()
    return p, fs


@router.get("", response_model=list[ProjectOut])
async def list_projects(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(
        select(Project).where(Project.owner_id == user.id).order_by(Project.last_opened_at.desc()).limit(100)
    )
    return list(rows)


@router.post("", response_model=ProjectOut, status_code=201)
async def create_project(
    body: ProjectCreate, request: Request, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
):
    p, fs = await _create(session, request, user, body.name.strip() or "Untitled", body.language)
    if body.template:
        for path, content in TEMPLATES[body.language].items():
            await asyncio.to_thread(fs.write, path, content.encode())
        p.settings = {"entry": DEFAULT_ENTRY[body.language]}
        await session.commit()
    return p


@router.post("/import", response_model=ProjectOut, status_code=201)
async def import_zip(
    request: Request,
    file: UploadFile = File(...),
    name: str | None = Form(None),
    language: str | None = Form(None),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    s = request.app.state.settings
    await _check_quota(session, user, request)
    raw = await file.read(s.max_upload_bytes + 1)
    if len(raw) > s.max_upload_bytes:
        raise HTTPException(413, "Archive is too large")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(400, "This is not a valid ZIP archive") from None
    entries = _zip_entries(zf, s)
    lang = language if language in TEMPLATES else detect_language([e[0] for e in entries])
    title = (name or (file.filename or "Imported").rsplit(".", 1)[0]).strip()[:120] or "Imported"
    p, fs = await _create(session, request, user, title, lang)

    def write_all() -> None:
        for path, data in entries:
            fs.write(path, data)

    try:
        await asyncio.to_thread(write_all)
    except FSError as e:
        fs.wipe()
        await session.delete(p)
        await session.commit()
        raise HTTPException(e.status, e.message) from None
    names = {e[0] for e in entries}
    entry = DEFAULT_ENTRY[lang]
    if entry not in names:
        ext = {"python": ".py", "cpp": ".cpp", "javascript": ".js"}[lang]
        entry = next((n for n in sorted(names) if n.endswith(ext)), entry)
    p.settings = {"entry": entry}
    await session.commit()
    return p


def _zip_entries(zf: zipfile.ZipFile, s) -> list[tuple[str, bytes]]:
    """Safely read an archive: no traversal, no links, bounded size."""
    out: list[tuple[str, bytes]] = []
    total = 0
    for info in zf.infolist():
        if info.is_dir():
            continue
        mode = info.external_attr >> 16
        if mode and stat.S_ISLNK(mode):
            continue
        name = info.filename.replace("\\", "/")
        try:
            parts = split_path(name, allow_hidden=True)
        except FSError:
            continue
        if any(p in HIDDEN_NAMES or p == ".git" for p in parts):
            continue
        total += info.file_size
        if total > s.max_project_bytes or len(out) >= s.max_files_per_project:
            raise HTTPException(413, "Archive exceeds the project size limits")
        with zf.open(info) as fh:
            data = fh.read(info.file_size + 1)
        out.append(("/".join(parts), data))
    if not out:
        raise HTTPException(400, "The archive contains no usable files")
    return out


@router.get("/{project_id}", response_model=ProjectOut)
async def get_project(project: Project = Depends(owned_project), session: AsyncSession = Depends(get_session)):
    project.last_opened_at = datetime.now(timezone.utc)
    await session.commit()
    return project


@router.patch("/{project_id}", response_model=ProjectOut)
async def patch_project(
    body: ProjectPatch,
    request: Request,
    project: Project = Depends(owned_project),
    session: AsyncSession = Depends(get_session),
):
    if body.name is not None:
        project.name = body.name.strip() or project.name
    if body.language is not None and body.language != project.language:
        fs = project_fs(request, project)
        project.language = body.language
        entry = DEFAULT_ENTRY[body.language]
        # Switching language keeps your files; add a starter file when none fits.
        if fs.exists(entry) is None:
            exts = {"python": ".py", "cpp": (".cpp", ".cc", ".cxx"), "javascript": ".js"}[body.language]
            existing = [e.path for e in fs.tree() if e.type == "file" and e.path.endswith(exts)]
            if existing:
                entry = existing[0]
            else:
                for path, content in TEMPLATES[body.language].items():
                    if fs.exists(path) is None:
                        await asyncio.to_thread(fs.write, path, content.encode())
        project.settings = {**project.settings, "entry": entry}
    if body.settings is not None:
        merged = {**project.settings, **body.settings.model_dump(exclude_unset=True)}
        if merged.get("entry"):
            try:
                merged["entry"] = "/".join(split_path(merged["entry"]))
            except FSError as e:
                raise HTTPException(400, e.message) from None
        project.settings = {k: v for k, v in merged.items() if v not in (None, "")}
    project.updated_at = datetime.now(timezone.utc)
    await session.commit()
    return project


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    request: Request, project: Project = Depends(owned_project), session: AsyncSession = Depends(get_session)
):
    fs = project_fs(request, project)
    await session.delete(project)
    await session.commit()
    await asyncio.to_thread(fs.wipe)


@router.get("/{project_id}/export")
async def export_zip(request: Request, project: Project = Depends(owned_project)):
    fs = project_fs(request, project)
    limit = request.app.state.settings.max_project_bytes

    def build() -> tempfile.SpooledTemporaryFile:
        tmp = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
        total = 0
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
            for e in fs.tree(max_entries=100_000):
                if e.type == "dir":
                    zf.writestr(e.path + "/", b"")
                    continue
                total += e.size
                if total > limit:
                    break
                try:
                    zf.writestr(e.path, fs.read(e.path))
                except FSError:
                    continue
        tmp.seek(0)
        return tmp

    tmp = await asyncio.to_thread(build)
    safe = re.sub(r"[^\w.\-]+", "_", project.name).strip("_") or "project"

    def chunks():
        try:
            while data := tmp.read(1 << 16):
                yield data
        finally:
            tmp.close()

    return StreamingResponse(
        chunks(), media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{safe}.zip"'}
    )
