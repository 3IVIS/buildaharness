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
from datetime import datetime, timedelta, timezone
from typing import Annotated

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db import User, get_session
from rate_limit import limiter   # Fix #3: shared limiter for auth brute-force protection

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
    token_type: str = "bearer"
    user_id:    str
    email:      str

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

def _make_token(user_id: str, email: str) -> str:
    return jwt.encode(
        {"sub": user_id, "email": email,
         "exp": datetime.now(timezone.utc) + timedelta(days=JWT_TTL_DAYS)},
        JWT_SECRET, algorithm=JWT_ALGORITHM,
    )

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
    try:
        payload = jwt.decode(
            creds.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM],
            options={"leeway": 30},  # 30-second leeway for clock skew tolerance
        )
        user_id: str = payload.get("sub", "")
        if not user_id:
            raise ValueError
    except (JWTError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/register", response_model=TokenResponse, status_code=201)
@limiter.limit("5/minute")   # Fix #3: prevent registration spam
async def register(request: Request, req: RegisterRequest, db: AsyncSession = Depends(get_session)):
    _validate_password(req.password)  # Fix #8

    existing = (await db.execute(select(User).where(User.email == req.email))).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    user = User(email=req.email, password_hash=_hash(req.password))
    db.add(user)
    await db.commit()
    await db.refresh(user)

    return TokenResponse(token=_make_token(str(user.id), user.email),
                         user_id=str(user.id), email=user.email)


@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")   # brute-force protection
async def login(request: Request, req: LoginRequest, db: AsyncSession = Depends(get_session)):
    user = (await db.execute(select(User).where(User.email == req.email))).scalar_one_or_none()

    # Fix #4: always run bcrypt regardless of whether the user exists.
    # Without this, a missing user returns in microseconds (no bcrypt call) while a
    # wrong-password attempt takes ~100 ms, leaking whether an email is registered.
    candidate_hash = user.password_hash if user else _DUMMY_HASH
    password_ok    = _verify(req.password, candidate_hash)

    if not user or not password_ok:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    return TokenResponse(token=_make_token(str(user.id), user.email),
                         user_id=str(user.id), email=user.email)


@router.get("/me", response_model=UserResponse)
async def me(user: User = Depends(current_user)):
    return UserResponse(user_id=str(user.id), email=user.email)
