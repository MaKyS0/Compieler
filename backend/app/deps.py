from __future__ import annotations

from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_session
from .models import Project, User
from .sandbox.base import Sandbox
from .security import decode_token
from .services.projectfs import ProjectFS

bearer = HTTPBearer(auto_error=False)


async def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    session: AsyncSession = Depends(get_session),
) -> User:
    if creds is None:
        raise HTTPException(401, "Not authenticated")
    uid = decode_token(creds.credentials)
    user = await session.get(User, uid) if uid is not None else None
    if user is None:
        raise HTTPException(401, "Invalid or expired session")
    now = datetime.now(timezone.utc)
    last = user.last_seen if user.last_seen.tzinfo else user.last_seen.replace(tzinfo=timezone.utc)
    if (now - last).total_seconds() > 600:
        user.last_seen = now
        await session.commit()
    return user


async def owned_project(
    project_id: int,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Project:
    """Authorisation gate for every project route: foreign projects look like they don't exist."""
    project = await session.get(Project, project_id)
    if project is None or project.owner_id != user.id:
        raise HTTPException(404, "Project not found")
    return project


def sandbox_of(request: Request) -> Sandbox:
    return request.app.state.sandbox


def project_fs(request: Request, project: Project) -> ProjectFS:
    s = request.app.state.settings
    return ProjectFS(s.projects_dir / str(project.id), sandbox_of(request).project_uid(project.id))
