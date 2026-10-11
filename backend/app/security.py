"""Password hashing and signed access tokens.

Passwords use Argon2id when ``argon2-cffi`` is installed (the default) and fall back to
scrypt from the standard library where that package cannot be built (Termux/Android).
Both formats are verified regardless of which one is currently used for new hashes.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import time

import jwt

from .config import get_settings

try:
    from argon2 import PasswordHasher
    from argon2.exceptions import InvalidHashError, VerificationError

    _hasher: PasswordHasher | None = PasswordHasher()
except ImportError:  # pragma: no cover - exercised via the forced fallback in tests
    _hasher = None
    InvalidHashError = VerificationError = Exception  # type: ignore[assignment,misc]

ALGORITHM = "HS256"
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2**14, 8, 1


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def _scrypt_hash(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=32, maxmem=64 * 1024 * 1024)


def hash_password(password: str) -> str:
    if _hasher is not None:
        return _hasher.hash(password)
    salt = os.urandom(16)
    digest = _scrypt_hash(password, salt, _SCRYPT_N, _SCRYPT_R, _SCRYPT_P)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, hashed: str | None) -> bool:
    if not hashed:
        return False
    if hashed.startswith("scrypt$"):
        try:
            _, n, r, p, salt, digest = hashed.split("$")
            calc = _scrypt_hash(password, base64.b64decode(salt), int(n), int(r), int(p))
            return hmac.compare_digest(calc, base64.b64decode(digest))
        except (ValueError, TypeError):
            return False
    if _hasher is None:
        return False  # an argon2 hash cannot be checked without argon2-cffi
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
