"""
JWT auth: /auth/register, /auth/login, /auth/me

Fixes applied:
  #3  — JWT_SECRET now fails at startup if unset (no hardcoded fallback).
  #7  — email validated as a real email address via pydantic EmailStr.
  #8  — password policy: min 8 chars + at least one letter and one digit.
  #pw — dropped passlib (abandoned, incompatible with bcrypt 4.x) in favour of
        calling the bcrypt package directly. bcrypt 4.x removed __about__ and
        raises ValueError for passwords > 72 bytes; passlib had no fix for either.
"""
import os
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db import User, get_session
from rate_limit import limiter  # Fix #3: shared limiter for auth brute-force protection

# org_context imports auth (for current_user), so we cannot import it at the
# module level here without a circular dependency.  We import lazily inside
# the register() route function instead, which is safe because Python caches
# the module after the first import and subsequent calls are fast.
# This comment documents the intentional lazy import pattern.

router = APIRouter(prefix="/auth", tags=["auth"])

# auth.py still reads JWT_SECRET directly so it has it available for token operations.
# main.py validates this env var before importing auth, so by the time this runs
# the variable is guaranteed to be set and non-insecure.
_raw_secret = os.getenv("JWT_SECRET", "")
JWT_SECRET    = _raw_secret
JWT_ALGORITHM = "HS256"
# Fix #7: make token lifetime configurable; default 30 days.
JWT_TTL_DAYS  = int(os.getenv("JWT_TTL_DAYS", "30"))

# Fix #4: pre-computed dummy hash used in constant-time login comparison.
# When the email is not in the database we still call _verify() against this
# hash so bcrypt always runs (~100 ms), preventing timing-based user enumeration.
# bcrypt is called directly — passlib is abandoned and broken on bcrypt 4.x.
_DUMMY_HASH: bytes = bcrypt.hashpw(
    b"itsharness-dummy-constant-time-sentinel", bcrypt.gensalt()
)
bearer = HTTPBearer()

# Fix #8: password complexity — at least one letter and one digit.
# Also enforce an upper bound of 72 bytes: bcrypt silently truncated in older
# versions but raises ValueError in bcrypt 4.x when the limit is exceeded.
_PW_COMPLEXITY = re.compile(r"^(?=.*[A-Za-z])(?=.*\d).{8,}$")
_PW_MAX_BYTES  = 72


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email:    EmailStr   # Fix #7: validates email format
    password: str

class LoginRequest(BaseModel):
    email:    EmailStr
    password: str

class TokenResponse(BaseModel):
    token:      str
    token_type: str = "bearer"  # noqa: S105
    user_id:    str
    email:      str
    jti:        str   # JWT ID — returned so clients can cache it for logout

class UserResponse(BaseModel):
    user_id: str
    email:   str


# ── Helpers ───────────────────────────────────────────────────────────────────

def _hash(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()

def _verify(plain: str, hashed: str | bytes) -> bool:
    plain_b  = plain.encode()
    hashed_b = hashed if isinstance(hashed, bytes) else hashed.encode()
    return bcrypt.checkpw(plain_b, hashed_b)

def _make_token(user_id: str, email: str) -> tuple[str, str]:
    """Return (encoded_jwt, jti).

    jti (JWT ID) is a random UUID embedded in the token payload.  It is stored
    in Redis on logout so every subsequent request that presents this token can
    be rejected even before the token's exp claim fires.
    """
    jti = str(uuid.uuid4())
    token = jwt.encode(
        {
            "sub":   user_id,
            "email": email,
            "jti":   jti,
            "exp":   datetime.now(UTC) + timedelta(days=JWT_TTL_DAYS),
        },
        JWT_SECRET, algorithm=JWT_ALGORITHM,
    )
    return token, jti

def _validate_password(pw: str) -> None:
    """Fix #8: min 8 chars, at least one letter, at least one digit.
    Also rejects passwords longer than 72 bytes — bcrypt 4.x raises ValueError
    instead of silently truncating, so we surface a clear 400 instead of a 500.
    """
    if len(pw.encode()) > _PW_MAX_BYTES:
        raise HTTPException(
            status_code=400,
            detail="Password must not exceed 72 characters.",
        )
    if not _PW_COMPLEXITY.match(pw):
        raise HTTPException(
            status_code=400,
            detail=(
                "Password must be at least 8 characters and contain "
                "at least one letter and one digit."
            ),
        )


async def current_user(
    creds: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
    db:    Annotated[AsyncSession, Depends(get_session)],
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
    )
    try:
        payload = jwt.decode(
            creds.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM],
            options={"leeway": 30},
        )
        user_id: str = payload.get("sub", "")
        jti: str     = payload.get("jti", "")
        if not user_id or not jti:
            raise ValueError
    except (JWTError, ValueError):
        raise credentials_exception from None

    # Check revocation — skip in TESTING mode (no Redis in CI).
    if os.getenv("TESTING") != "true":
        from redis_client import is_revoked
        if await is_revoked(jti):
            raise credentials_exception from None

    user = await db.get(User, user_id)
    if not user:
        raise credentials_exception from None
    return user


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/register", response_model=TokenResponse, status_code=201)
@limiter.limit("5/minute")
async def register(request: Request, req: RegisterRequest, db: AsyncSession = Depends(get_session)):
    _validate_password(req.password)

    existing = (await db.execute(select(User).where(User.email == req.email))).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    user = User(email=req.email, password_hash=_hash(req.password))
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Create the user's personal org (idempotent; also handles the lazy-create
    # path for users who existed before migration 0005).
    from org_context import ensure_personal_org
    await ensure_personal_org(user, db)

    token, jti = _make_token(str(user.id), user.email)
    return TokenResponse(token=token, user_id=str(user.id), email=user.email, jti=jti)


@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
async def login(request: Request, req: LoginRequest, db: AsyncSession = Depends(get_session)):
    user = (await db.execute(select(User).where(User.email == req.email))).scalar_one_or_none()

    # Fix #4: constant-time comparison to prevent user enumeration via timing.
    candidate_hash = user.password_hash if user else _DUMMY_HASH
    password_ok    = _verify(req.password, candidate_hash)

    if not user or not password_ok:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token, jti = _make_token(str(user.id), user.email)
    return TokenResponse(token=token, user_id=str(user.id), email=user.email, jti=jti)


@router.post("/logout", status_code=204)
@limiter.limit("60/minute")
async def logout(
    request: Request,
    creds: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
):
    """Revoke the presented JWT by writing its jti to the Redis blocklist.

    TTL is set to the token's remaining lifetime so Redis self-cleans.
    Returns 204 regardless of prior revocation state to avoid leaking
    information about token membership in the blocklist.
    """
    if os.getenv("TESTING") == "true":
        return  # no-op in test suite — no Redis in CI

    try:
        payload = jwt.decode(
            creds.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM],
            options={"leeway": 30, "verify_exp": False},  # revoke even expired tokens
        )
        jti: str = payload.get("jti", "")
        exp: int = payload.get("exp", 0)
    except JWTError:
        return  # malformed token — nothing to revoke; still 204

    if jti:
        from redis_client import revoke_token
        remaining = max(0, exp - int(datetime.now(UTC).timestamp()))
        if remaining > 0:
            await revoke_token(jti, remaining)


@router.get("/me", response_model=UserResponse)
async def me(user: User = Depends(current_user)):
    return UserResponse(user_id=str(user.id), email=user.email)
