#!/usr/bin/env bash
# verify_observability.sh — Confirm Langfuse tracing is active for all 4 runtimes.
#
# For each runtime (langgraph, mastra, crewai, microsoft_agent_framework):
#   1. Submits the minimal Ollama simple flow
#   2. Polls to completion (no HITL in that flow)
#   3. Asserts trace_id and trace_url are present in the job response
#   4. Waits for the OTel span batch to flush, then verifies the trace in Langfuse
#
# Usage:
#   ./verify_observability.sh [spec-file]
#
# Environment (all optional — defaults shown):
#   BASE_URL             http://localhost:8000
#   LANGFUSE_BASE_URL    http://localhost:3001   (external host port for Langfuse)
#   LANGFUSE_FLUSH_WAIT  20   seconds to wait after job completion for OTel flush
#   LANGFUSE_PUBLIC_KEY  read from .env if not set
#   LANGFUSE_SECRET_KEY  read from .env if not set

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Config ────────────────────────────────────────────────────────────────────
BASE_URL="${BASE_URL:-http://localhost:8000}"
LANGFUSE_BASE_URL="${LANGFUSE_BASE_URL:-http://localhost:3001}"
SPEC_FILE="${1:-flows/06-ollama-simple-flow.json}"
POLL_INTERVAL="${POLL_INTERVAL:-3}"
LANGFUSE_FLUSH_WAIT="${LANGFUSE_FLUSH_WAIT:-20}"
CONTENT_HEADER="Content-Type: application/json"

# Load LANGFUSE keys from .env if not already in environment
if [[ -f ".env" ]]; then
  _load_from_env() {
    local key="$1"
    if [[ -z "${!key:-}" ]]; then
      local val
      val=$(grep -E "^${key}=" .env | head -1 | cut -d= -f2-)
      if [[ -n "$val" ]]; then
        export "$key=$val"
      fi
    fi
  }
  _load_from_env LANGFUSE_PUBLIC_KEY
  _load_from_env LANGFUSE_SECRET_KEY
fi

LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY:-}"
LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY:-}"

# ── Helpers ───────────────────────────────────────────────────────────────────
PASS=0
FAIL=0
declare -a RESULTS=()

record_pass() { PASS=$((PASS+1)); RESULTS+=("PASS  $1"); }
record_fail() { FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1"); }

# ── Preflight ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  itsharness — Observability (Langfuse) verification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Adapter:   $BASE_URL"
echo "  Langfuse:  $LANGFUSE_BASE_URL"
echo "  Spec:      $SPEC_FILE"
echo ""

if [[ ! -f "$SPEC_FILE" ]]; then
  echo "ERROR: Spec file not found: $SPEC_FILE" >&2
  exit 1
fi

# Check Langfuse keys
if [[ -z "$LANGFUSE_PUBLIC_KEY" || -z "$LANGFUSE_SECRET_KEY" ]]; then
  echo "ERROR: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set (or present in .env)." >&2
  exit 1
fi
echo "  ✓  Langfuse keys found."

# Check Langfuse reachability
echo "  Checking Langfuse health..."
LF_HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "$LANGFUSE_BASE_URL/api/public/health" 2>/dev/null || echo "000")
if [[ "$LF_HEALTH_STATUS" != "200" ]]; then
  echo "ERROR: Langfuse not reachable at $LANGFUSE_BASE_URL (HTTP $LF_HEALTH_STATUS)." >&2
  exit 1
fi
echo "  ✓  Langfuse reachable."

# ── Auth ──────────────────────────────────────────────────────────────────────
echo ""
printf "  Email:    "
read -r EMAIL
printf "  Password: "
read -rs PASSWORD
echo ""
echo ""

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "ERROR: Email and password are required." >&2
  exit 1
fi

CREDS_JSON=$(python3 -c "import json; print(json.dumps({'email': '$EMAIL', 'password': '$PASSWORD'}))")

echo "  Signing in..."
LOGIN_HTTP=$(curl -s -o /tmp/_itsharness_obs_body.json -w "%{http_code}" \
  -X POST "$BASE_URL/auth/login" \
  -H "$CONTENT_HEADER" -d "$CREDS_JSON")
LOGIN_BODY=$(cat /tmp/_itsharness_obs_body.json)

if [[ "$LOGIN_HTTP" == "200" ]]; then
  TOKEN=$(echo "$LOGIN_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
  echo "  ✓  Logged in."
elif [[ "$LOGIN_HTTP" == "401" ]]; then
  echo "  Account not found, creating..."
  REG_HTTP=$(curl -s -o /tmp/_itsharness_obs_body.json -w "%{http_code}" \
    -X POST "$BASE_URL/auth/register" \
    -H "$CONTENT_HEADER" -d "$CREDS_JSON")
  REG_BODY=$(cat /tmp/_itsharness_obs_body.json)
  if [[ "$REG_HTTP" == "201" ]]; then
    TOKEN=$(echo "$REG_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
    echo "  ✓  Account created and logged in."
  elif [[ "$REG_HTTP" == "409" ]]; then
    echo "ERROR: Account exists but password is incorrect." >&2; exit 1
  else
    ERR=$(echo "$REG_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('detail',d))" 2>/dev/null || echo "$REG_BODY")
    echo "ERROR: Registration failed ($REG_HTTP): $ERR" >&2; exit 1
  fi
else
  ERR=$(echo "$LOGIN_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('detail',d))" 2>/dev/null || echo "$LOGIN_BODY")
  echo "ERROR: Login failed ($LOGIN_HTTP): $ERR" >&2; exit 1
fi

AUTH_HEADER="Authorization: Bearer $TOKEN"

# ── Per-runtime verification ──────────────────────────────────────────────────
verify_runtime() {
  local RUNTIME="$1"
  # Unique temp files per call to avoid cross-runtime contamination.
  local TMP_SUBMIT="/tmp/_itsharness_obs_submit_${RUNTIME}.json"
  local TMP_LF="/tmp/_itsharness_obs_lf_${RUNTIME}.json"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Runtime: $RUNTIME"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # 1. Submit job
  local SUBMIT_RESPONSE
  SUBMIT_RESPONSE=$(curl -s -X POST "$BASE_URL/run?runtime=$RUNTIME" \
    -H "$AUTH_HEADER" -H "$CONTENT_HEADER" \
    -d "{\"spec\": $(cat "$SPEC_FILE"), \"inputs\": {\"topic\": \"observability testing\"}}")

  local JOB_ID
  JOB_ID=$(echo "$SUBMIT_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])" 2>/dev/null || echo "")
  if [[ -z "$JOB_ID" ]]; then
    echo "  ✗  Failed to submit job."
    echo "     Response: $SUBMIT_RESPONSE"
    record_fail "$RUNTIME — job submission failed"
    return
  fi
  echo "  Job ID: $JOB_ID"

  # 2. Poll to completion
  local FINAL_RESPONSE=""
  while true; do
    sleep "$POLL_INTERVAL"
    local RESPONSE STATUS
    RESPONSE=$(curl -s "$BASE_URL/run/$JOB_ID" -H "$AUTH_HEADER")
    STATUS=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "unknown")

    if [[ "$STATUS" == "done" ]]; then
      echo "  ✓  Job completed."
      FINAL_RESPONSE="$RESPONSE"
      break
    elif [[ "$STATUS" == "error" ]]; then
      local ERR
      ERR=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null)
      echo "  ✗  Job failed: $ERR"
      record_fail "$RUNTIME — job failed: $ERR"
      return
    elif [[ "$STATUS" == "paused" ]]; then
      echo "  ✗  Unexpected HITL pause — use a flow without human-in-the-loop nodes."
      record_fail "$RUNTIME — unexpected HITL pause"
      return
    else
      printf "  …  Status: %s\r" "$STATUS"
    fi
  done

  # 3. Check trace_id and trace_url in job response.
  #    The trace_id write is async relative to job completion; retry a few times.
  local TRACE_ID="" TRACE_URL=""
  for _i in 1 2 3; do
    TRACE_ID=$(echo "$FINAL_RESPONSE" | python3 -c "import sys,json; v=json.load(sys.stdin).get('trace_id'); print(v if v else '')" 2>/dev/null)
    if [[ -n "$TRACE_ID" ]]; then break; fi
    sleep 3
    FINAL_RESPONSE=$(curl -s "$BASE_URL/run/$JOB_ID" -H "$AUTH_HEADER")
  done
  TRACE_URL=$(echo "$FINAL_RESPONSE" | python3 -c "import sys,json; v=json.load(sys.stdin).get('trace_url'); print(v if v else '')" 2>/dev/null)

  if [[ -z "$TRACE_ID" ]]; then
    echo "  ✗  trace_id is missing from job response — Langfuse integration is not active."
    record_fail "$RUNTIME — trace_id missing (is LANGFUSE_PUBLIC_KEY set in adapter env?)"
    return
  fi
  echo "  ✓  trace_id:  $TRACE_ID"

  if [[ -z "$TRACE_URL" ]]; then
    echo "  ✗  trace_url is missing from job response."
    record_fail "$RUNTIME — trace_url missing"
    return
  fi
  echo "  ✓  trace_url: $TRACE_URL"

  # 4. Wait for OTel batch flush + Langfuse worker processing, then verify the trace.
  echo "  Waiting ${LANGFUSE_FLUSH_WAIT}s for OTel flush and ingestion..."
  sleep "$LANGFUSE_FLUSH_WAIT"

  echo "  Verifying trace in Langfuse..."
  local LF_HTTP_CODE LF_BODY
  # Capture HTTP code and body separately to avoid the || echo "000" double-output issue.
  if curl -s -o "$TMP_LF" -w "%{http_code}" \
       -u "${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}" \
       "$LANGFUSE_BASE_URL/api/public/traces/$TRACE_ID" \
       > /tmp/_itsharness_obs_http_"${RUNTIME}".txt 2>/dev/null; then
    LF_HTTP_CODE=$(cat /tmp/_itsharness_obs_http_"${RUNTIME}".txt)
  else
    LF_HTTP_CODE="000"
  fi
  LF_BODY=$(cat "$TMP_LF" 2>/dev/null || echo "{}")

  if [[ "$LF_HTTP_CODE" == "200" ]]; then
    local LF_TRACE_ID
    LF_TRACE_ID=$(echo "$LF_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
    if [[ "$LF_TRACE_ID" == "$TRACE_ID" ]]; then
      echo "  ✓  Trace confirmed in Langfuse."
      record_pass "$RUNTIME"
    else
      echo "  ✗  Langfuse returned a different trace ID: $LF_TRACE_ID"
      record_fail "$RUNTIME — trace ID mismatch in Langfuse"
    fi
  elif [[ "$LF_HTTP_CODE" == "404" ]]; then
    echo "  ✗  Trace not found in Langfuse (HTTP 404). OTel export may still be failing."
    record_fail "$RUNTIME — trace not found in Langfuse"
  elif [[ "$LF_HTTP_CODE" == "401" || "$LF_HTTP_CODE" == "403" ]]; then
    echo "  ✗  Langfuse API auth failed (HTTP $LF_HTTP_CODE). Check LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY."
    record_fail "$RUNTIME — Langfuse API auth failed"
  elif [[ "$LF_HTTP_CODE" == "000" ]]; then
    echo "  ✗  Could not connect to Langfuse at $LANGFUSE_BASE_URL."
    record_fail "$RUNTIME — Langfuse unreachable during trace verification"
  else
    local ERR
    ERR=$(echo "$LF_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message',d))" 2>/dev/null || echo "$LF_BODY")
    echo "  ✗  Langfuse API error ($LF_HTTP_CODE): $ERR"
    record_fail "$RUNTIME — Langfuse API error $LF_HTTP_CODE"
  fi
}

verify_runtime "langgraph"
verify_runtime "mastra"
verify_runtime "crewai"
verify_runtime "microsoft_agent_framework"

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

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
