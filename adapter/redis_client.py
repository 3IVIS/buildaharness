"""
Async Redis client for itsharness.

Provides a single shared ConnectionPool and two focused helpers:

    revoke_token(jti, ttl_seconds)   — add a jti to the revocation set
    is_revoked(jti)                  — return True if jti has been revoked

The client uses the REDIS_URL env var (default: redis://redis:6379/1).
Redis database 1 is reserved for itsharness; database 0 is used by
Langfuse's BullMQ ingestion queue, so the two stacks never share keyspace.

The key prefix itsharness:revoked:{jti} provides an additional safety
margin against accidental collision on shared Redis instances.

TESTING=true:
    The revocation check in current_user() and the revoke_token() call in
    logout() are both skipped at the call site, so no Redis connection is
    ever opened during the test suite.  No fakeredis dependency needed.
"""

import os

import redis.asyncio as aioredis

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/1")
_KEY_PREFIX = "itsharness:revoked:"

# Module-level pool — created once, shared across requests.
_pool: aioredis.ConnectionPool | None = None


def _get_pool() -> aioredis.ConnectionPool:
    global _pool
    if _pool is None:
        _pool = aioredis.ConnectionPool.from_url(
            REDIS_URL,
            max_connections=10,
            decode_responses=True,
        )
    return _pool


def get_redis() -> aioredis.Redis:
    """Return a Redis client backed by the shared pool."""
    return aioredis.Redis(connection_pool=_get_pool())


async def revoke_token(jti: str, ttl_seconds: int) -> None:
    """Store jti in Redis with a TTL matching the token's remaining lifetime.

    After TTL expires the key is automatically evicted — no cleanup needed.
    """
    r = get_redis()
    await r.setex(f"{_KEY_PREFIX}{jti}", ttl_seconds, "1")


async def is_revoked(jti: str) -> bool:
    """Return True if this jti has been explicitly revoked."""
    r = get_redis()
    return await r.exists(f"{_KEY_PREFIX}{jti}") > 0


async def close_pool() -> None:
    """Disconnect the shared pool — call from app lifespan on shutdown.

    redis-py 5.x: ConnectionPool.disconnect() is synchronous (no await).
    aclose() is the async-safe shutdown path introduced in redis-py 5.0.
    """
    global _pool
    if _pool is not None:
        await _pool.aclose()
        _pool = None
