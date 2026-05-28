#!/usr/bin/env bash
# verify_services.sh — Confirm every itsharness service is up, healthy, and reachable.
#
# Checks (no user prompts — credentials are read from .env):
#   1. Every Docker container is in "running" state
#   2. Every container with a healthcheck reports "healthy"
#   3. HTTP endpoints respond with the expected status and body
#   4. Credential-layer checks: Redis PING, PostgreSQL pg_isready, Langfuse API auth
#   5. Inter-service connectivity from inside the adapter container
#
# Usage:
#   ./verify_services.sh
#
# Environment (all optional — host overrides .env):
#   BASE_URL          http://localhost:8000   (adapter)
#   LANGFUSE_URL      http://localhost:3001
#   LITELLM_URL       http://localhost:4000
#   MASTRA_URL        http://localhost:8001
#   CANVAS_URL        http://localhost:3000
#   MINIO_URL         http://localhost:9002
#   CLICKHOUSE_URL    http://localhost:8123
#   REDIS_HOST        localhost
#   REDIS_PORT        6379
#   POSTGRES_HOST     localhost
#   POSTGRES_PORT     5432

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Config ────────────────────────────────────────────────────────────────────
BASE_URL="${BASE_URL:-http://localhost:8000}"
LANGFUSE_URL="${LANGFUSE_URL:-http://localhost:3001}"
LITELLM_URL="${LITELLM_URL:-http://localhost:4000}"
MASTRA_URL="${MASTRA_URL:-http://localhost:8001}"
CANVAS_URL="${CANVAS_URL:-http://localhost:3000}"
MINIO_URL="${MINIO_URL:-http://localhost:9002}"
CLICKHOUSE_URL="${CLICKHOUSE_URL:-http://localhost:8123}"
REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"

# ── Load credentials from .env ────────────────────────────────────────────────
_env_val() {
  local key="$1" default="${2:-}"
  local val="${!key:-}"
  if [[ -z "$val" && -f ".env" ]]; then
    val=$(grep -E "^${key}=" .env | head -1 | cut -d= -f2-)
  fi
  echo "${val:-$default}"
}

REDIS_PASSWORD=$(_env_val REDIS_PASSWORD)
POSTGRES_PASSWORD=$(_env_val POSTGRES_PASSWORD)
CLICKHOUSE_PASSWORD=$(_env_val CLICKHOUSE_PASSWORD)
LANGFUSE_PUBLIC_KEY=$(_env_val LANGFUSE_PUBLIC_KEY)
LANGFUSE_SECRET_KEY=$(_env_val LANGFUSE_SECRET_KEY)

# ── Result tracking ───────────────────────────────────────────────────────────
PASS=0
FAIL=0
declare -a RESULTS=()

_pass() { PASS=$((PASS+1)); RESULTS+=("PASS  $1"); echo "  ✓  $1"; }
_fail() { FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1"); echo "  ✗  $1"; }
_section() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  itsharness — Service verification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Container state ────────────────────────────────────────────────────────
_section "1. Container state"

_check_running() {
  local name="$1" label="${2:-$1}"
  local state
  state=$(docker inspect "$name" --format '{{.State.Status}}' 2>/dev/null || echo "missing")
  if [[ "$state" == "running" ]]; then
    _pass "$label — running"
  else
    _fail "$label — expected running, got: $state"
  fi
}

_check_running itsharness-adapter-1          "adapter"
_check_running itsharness-mastra-runner-1     "mastra-runner"
_check_running itsharness-litellm-1           "litellm"
_check_running itsharness-langfuse-1          "langfuse"
_check_running itsharness-langfuse-worker-1   "langfuse-worker"
_check_running itsharness-canvas-1            "canvas"
_check_running itsharness-postgres-1          "postgres"
_check_running itsharness-redis-1             "redis"
_check_running itsharness-clickhouse-1        "clickhouse"
_check_running itsharness-minio-1             "minio"

# ── 2. Docker healthchecks ────────────────────────────────────────────────────
_section "2. Docker healthchecks"

_check_healthy() {
  local name="$1" label="${2:-$1}"
  local health
  # .State.Health is absent (not nil) when no healthcheck is configured;
  # docker inspect exits non-zero with a template error in that case.
  health=$(docker inspect "$name" --format '{{.State.Health.Status}}' 2>/dev/null) || health="none"
  if [[ "$health" == "healthy" ]]; then
    _pass "$label — healthy"
  elif [[ -z "$health" || "$health" == "none" || "$health" == "<nil>" ]]; then
    echo "  –  $label — no healthcheck configured (skipped)"
  else
    _fail "$label — $health"
  fi
}

_check_healthy itsharness-adapter-1          "adapter"
_check_healthy itsharness-mastra-runner-1     "mastra-runner"
_check_healthy itsharness-litellm-1           "litellm"
_check_healthy itsharness-langfuse-1          "langfuse"
_check_healthy itsharness-langfuse-worker-1   "langfuse-worker"
_check_healthy itsharness-postgres-1          "postgres"
_check_healthy itsharness-redis-1             "redis"
_check_healthy itsharness-clickhouse-1        "clickhouse"
_check_healthy itsharness-minio-1             "minio"

# ── 3. HTTP endpoint checks ───────────────────────────────────────────────────
_section "3. HTTP endpoints"

_check_http() {
  local label="$1" url="$2" expected_code="${3:-200}" contains="${4:-}"
  local body http_code tmp
  tmp=$(mktemp)
  if http_code=$(curl -s -o "$tmp" -w "%{http_code}" --max-time 5 "$url" 2>/dev/null); then
    body=$(cat "$tmp"); rm -f "$tmp"
    if [[ "$http_code" != "$expected_code" ]]; then
      _fail "$label — expected HTTP $expected_code, got $http_code ($url)"
      return
    fi
    if [[ -n "$contains" && "$body" != *"$contains"* ]]; then
      _fail "$label — response missing \"$contains\" ($url)"
      return
    fi
    _pass "$label — HTTP $http_code"
  else
    rm -f "$tmp"
    _fail "$label — connection failed ($url)"
  fi
}

# Adapter
_check_http "adapter /health"         "$BASE_URL/health"                        200 '"status":"ok"'
_check_http "adapter /runtimes"       "$BASE_URL/runtimes"                      200 '"runtimes"'

# Mastra runner
_check_http "mastra-runner /health"   "$MASTRA_URL/health"                      200 '"status":"ok"'

# LiteLLM
_check_http "litellm /health/liveliness" "$LITELLM_URL/health/liveliness"       200

# Langfuse web
_check_http "langfuse /api/public/health" "$LANGFUSE_URL/api/public/health"     200 '"status":"OK"'

# MinIO S3 API
_check_http "minio /minio/health/live"   "$MINIO_URL/minio/health/live"         200

# ClickHouse HTTP interface
_check_http "clickhouse SELECT 1"     \
  "http://default:${CLICKHOUSE_PASSWORD}@${CLICKHOUSE_URL#http://}/?query=SELECT+1" \
  200 "1"

# Canvas dev server
_check_http "canvas /"                "$CANVAS_URL/"                            200

# ── 4. Credential-layer checks ────────────────────────────────────────────────
_section "4. Credentials and auth"

# Redis PING
if command -v redis-cli &>/dev/null; then
  _redis_resp=$(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" \
                  --no-auth-warning ping 2>/dev/null || echo "")
  if [[ "$_redis_resp" == "PONG" ]]; then
    _pass "redis — PING/PONG"
  else
    _fail "redis — unexpected response: $_redis_resp"
  fi
else
  # Fallback: check via docker exec
  _redis_resp=$(docker exec itsharness-redis-1 \
    redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping 2>/dev/null || echo "")
  if [[ "$_redis_resp" == "PONG" ]]; then
    _pass "redis — PING/PONG (via docker exec)"
  else
    _fail "redis — unreachable (redis-cli not installed and docker exec failed)"
  fi
fi

# PostgreSQL pg_isready
if command -v pg_isready &>/dev/null; then
  if pg_isready -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U itsharness -q 2>/dev/null; then
    _pass "postgres — accepting connections"
  else
    _fail "postgres — not accepting connections"
  fi
else
  # Fallback: check via docker exec
  if docker exec itsharness-postgres-1 pg_isready -U itsharness -q 2>/dev/null; then
    _pass "postgres — accepting connections (via docker exec)"
  else
    _fail "postgres — unreachable (pg_isready not installed and docker exec failed)"
  fi
fi

# Langfuse project API key auth
if [[ -z "$LANGFUSE_PUBLIC_KEY" || -z "$LANGFUSE_SECRET_KEY" ]]; then
  _fail "langfuse API auth — LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set"
else
  _tmp=$(mktemp)
  _lf_code=$(curl -s -o "$_tmp" -w "%{http_code}" --max-time 5 \
    -u "${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}" \
    "$LANGFUSE_URL/api/public/traces?limit=1" 2>/dev/null || echo "000")
  _lf_body=$(cat "$_tmp"); rm -f "$_tmp"
  if [[ "$_lf_code" == "200" ]]; then
    _pass "langfuse API auth — project key accepted"
  elif [[ "$_lf_code" == "401" || "$_lf_code" == "403" ]]; then
    _fail "langfuse API auth — key rejected (HTTP $_lf_code). Check LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY."
  else
    _fail "langfuse API auth — unexpected HTTP $_lf_code"
  fi
fi

# MinIO bucket exists (langfuse-events)
# S3 REST API requires AWS Sig V4 — use mc (bundled in the minio server image) instead.
_mc_out=$(docker exec itsharness-minio-1 \
  mc ls local/langfuse-events 2>&1) && _mc_exit=0 || _mc_exit=$?
if [[ "$_mc_exit" -eq 0 ]]; then
  _pass "minio — langfuse-events bucket accessible"
else
  # mc alias 'local' may not be set in the server image; set it on the fly.
  if docker exec itsharness-minio-1 sh -c \
      "mc alias set local http://localhost:9000 langfuse langfuse-minio-dev >/dev/null 2>&1 \
       && mc ls local/langfuse-events >/dev/null 2>&1"; then
    _pass "minio — langfuse-events bucket accessible"
  else
    _fail "minio — langfuse-events bucket missing or unreachable (run: docker compose up minio-init)"
  fi
fi

# ── 5. Inter-service connectivity ─────────────────────────────────────────────
_section "5. Inter-service connectivity (from adapter container)"

_check_from_adapter() {
  local label="$1" url="$2"
  local result
  result=$(docker exec itsharness-adapter-1 python3 -c "
import urllib.request, urllib.error, sys
try:
    r = urllib.request.urlopen('$url', timeout=5)
    print('ok', r.status)
except urllib.error.HTTPError as e:
    # Non-2xx is still a reachable endpoint
    print('ok', e.code)
except Exception as e:
    print('fail', str(e))
" 2>/dev/null || echo "fail docker-exec-error")
  if [[ "$result" == ok* ]]; then
    _pass "$label — reachable (${result#ok })"
  else
    _fail "$label — ${result#fail }"
  fi
}

_check_from_adapter "adapter → langfuse"     "http://langfuse:3000/api/public/health"
_check_from_adapter "adapter → litellm"      "http://litellm:4000/health/liveliness"
_check_tcp_from_adapter() {
  local label="$1" host="$2" port="$3"
  local result
  result=$(docker exec itsharness-adapter-1 python3 -c "
import socket
try:
    s = socket.create_connection(('$host', $port), timeout=3)
    s.close()
    print('ok')
except Exception as e:
    print('fail', e)
" 2>/dev/null || echo "fail docker-exec-error")
  if [[ "$result" == "ok" ]]; then
    _pass "$label — TCP port $port reachable"
  else
    _fail "$label — ${result#fail }"
  fi
}

_check_tcp_from_adapter "adapter → postgres"  postgres 5432
_check_tcp_from_adapter "adapter → redis"     redis    6379
_check_from_adapter "adapter → mastra-runner" "http://mastra-runner:8001/health"
_check_from_adapter "adapter → minio"        "http://minio:9000/minio/health/live"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
for line in "${RESULTS[@]}"; do
  if [[ "$line" == PASS* ]]; then
    echo "  ✓  ${line#PASS  }"
  else
    echo "  ✗  ${line#FAIL  }"
  fi
done
echo ""
echo "  Passed: $PASS / $((PASS+FAIL))"
echo ""

[[ "$FAIL" -eq 0 ]]
