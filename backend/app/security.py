"""Password hashing and signed access tokens."""
from __future__ import annotations

import time

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from .config import get_settings

_hasher = PasswordHasher()
ALGORITHM = "HS256"


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, hashed: str | None) -> bool:
    if not hashed:
        return False
    try:
        return _hasher.verify(hashed, password)
    except (VerificationError, InvalidHashError):
        return False


def create_token(user_id: int) -> str:
    s = get_settings()
    now = int(time.time())
    payload = {"sub": str(user_id), "iat": now, "exp": now + s.token_ttl_days * 86400}
    return jwt.encode(payload, s.secret_key, algorithm=ALGORITHM)


def decode_token(token: str) -> int | None:
    try:
        data = jwt.decode(token, get_settings().secret_key, algorithms=[ALGORITHM])
        return int(data["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None
