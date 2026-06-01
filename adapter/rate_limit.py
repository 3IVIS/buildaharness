"""
Shared slowapi Limiter instance.

Fix #2: run_api.py previously created its own Limiter() that was never attached
to app.state.limiter, so RateLimitExceeded exceptions were uncaught → 500.

Fix #3: /auth/register and /auth/login had no rate limiting at all.

Fix #8: get_remote_address reads request.client.host (the TCP peer address).
When the adapter runs directly (no proxy), this is the real client IP — correct.
When behind a reverse proxy (nginx, AWS ALB, Cloudflare), request.client.host is
always the proxy address and every client shares one rate-limit bucket.

We use a custom key function that honours X-Real-IP (set by nginx's proxy_pass)
and falls back to X-Forwarded-For (first entry), then to the TCP peer address.

SECURITY NOTE: only enable X-Real-IP / X-Forwarded-For trust when the adapter
is behind a proxy that authenticates those headers.  If the adapter is exposed
directly to the internet, clients can spoof these headers to appear as any IP.
Set TRUST_PROXY=false in that scenario to force the TCP peer address.
"""

import os as _os

from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request


def _rate_limit_key(request: Request) -> str:
    """
    Proxy-aware rate-limit key.
    Controlled by the TRUST_PROXY env var (default: true).
    Set TRUST_PROXY=false when the adapter is exposed directly to the internet.
    """
    trust_proxy = _os.getenv("TRUST_PROXY", "true").lower() not in ("false", "0", "no")

    if trust_proxy:
        # nginx sets X-Real-IP to the actual client IP before proxying.
        real_ip = request.headers.get("X-Real-IP")
        if real_ip:
            return real_ip.strip()

        # AWS ALB / Cloudflare / generic proxies use X-Forwarded-For.
        forwarded_for = request.headers.get("X-Forwarded-For")
        if forwarded_for:
            return forwarded_for.split(",")[0].strip()

    # Direct connection or TRUST_PROXY=false — use the TCP peer address.
    return get_remote_address(request)


def _test_key(request: Request) -> str:
    """
    In test mode each call gets a unique key so no two requests share a bucket.
    This prevents the rate limiter from interfering with the test suite while
    keeping the limiter wired up (middleware, exception handlers all still run).
    """
    import uuid

    return str(uuid.uuid4())


# Single shared instance — imported by main.py and every router that rate-limits.
# Set TESTING=true (done in conftest.py) to switch to per-call unique keys so
# the 5/min register limit never fires during the test suite.
_key_func = _test_key if _os.getenv("TESTING") == "true" else _rate_limit_key
limiter = Limiter(key_func=_key_func)
