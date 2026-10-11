from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import bearer, current_user
from ..models import Project, User
from ..schemas import AuthOut, Credentials, UserOut
from ..security import create_token, decode_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "?"


def _throttle(request: Request, bucket: str, limit: int, window: float) -> None:
    if not request.app.state.limiter.allow((bucket, _client_ip(request)), limit, window):
        raise HTTPException(429, "Too many attempts, please wait a moment and retry")


def _out(user: User) -> AuthOut:
    return AuthOut(token=create_token(user.id), user=UserOut.model_validate(user))


@router.post("/guest", response_model=AuthOut)
async def guest(request: Request, session: AsyncSession = Depends(get_session)):
    """Anonymous account for temporary projects; can be upgraded by registering."""
    _throttle(request, "guest", request.app.state.settings.guests_per_hour, 3600)
    user = User(is_guest=True, name="Guest")
    session.add(user)
    await session.commit()
    return _out(user)


async def _optional_user(creds: HTTPAuthorizationCredentials | None, session: AsyncSession) -> User | None:
    if creds is None:
        return None
    uid = decode_token(creds.credentials)
    return await session.get(User, uid) if uid is not None else None


@router.post("/register", response_model=AuthOut)
async def register(
    body: Credentials,
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    session: AsyncSession = Depends(get_session),
):
    if not request.app.state.settings.allow_registration:
        raise HTTPException(403, "Registration is disabled")
    _throttle(request, "auth", request.app.state.settings.auth_attempts_per_5min, 300)
    exists = await session.scalar(select(User).where(User.email == body.email))
    if exists is not None:
        raise HTTPException(409, "This e-mail is already registered")
    user = await _optional_user(creds, session)
    if user is not None and user.is_guest:  # keep the guest's projects
        user.email, user.is_guest = body.email, False
        user.name = body.name or body.email.split("@")[0]
        user.password_hash = hash_password(body.password)
    else:
        user = User(email=body.email, is_guest=False, name=body.name or body.email.split("@")[0],
                    password_hash=hash_password(body.password))
        session.add(user)
    await session.commit()
    return _out(user)


@router.post("/login", response_model=AuthOut)
async def login(
    body: Credentials,
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    session: AsyncSession = Depends(get_session),
):
    _throttle(request, "auth", request.app.state.settings.auth_attempts_per_5min, 300)
    user = await session.scalar(select(User).where(User.email == body.email))
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Wrong e-mail or password")
    guest_user = await _optional_user(creds, session)
    if guest_user is not None and guest_user.is_guest and guest_user.id != user.id:
        # carry temporary projects over to the account
        await session.execute(update(Project).where(Project.owner_id == guest_user.id).values(owner_id=user.id))
        await session.delete(guest_user)
    await session.commit()
    return _out(user)


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(current_user)):
    return user
