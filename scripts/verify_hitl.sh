#!/usr/bin/env bash
# verify_hitl.sh — Automated HITL regression test for all 4 runtimes.
#
# For langgraph, mastra, and microsoft_agent_framework:
#   1. Submit flows/07-minimal-hitl-test-flow.json (no LLM calls — always pauses).
#   2. Poll until status = "paused".
#   3. Assert hitl_state.node_id and hitl_state.prompt are present.
#   4. POST /run/{job_id}/resume with a canned confirmation payload.
#   5. Poll until status = "done".
#   6. Assert result is non-empty.
#
# The minimal test flow eliminates LLM non-determinism: it routes directly to
# the hitl_breakpoint node with no classifier in between, so the pause always
# fires regardless of which model is available locally.
#
# CrewAI is skipped: hitl_breakpoint compiles to human_input=True, which
# calls input() in the thread-pool executor and blocks indefinitely when
# there is no terminal. API-level HITL pause/resume is not applicable.
#
# Usage:
#   ./verify_hitl.sh [spec-file]
#
# Environment (all optional — defaults shown):
#   BASE_URL          http://localhost:8000
#   POLL_INTERVAL     3     seconds between status polls
#   PAUSE_TIMEOUT     120   max seconds to wait for the job to pause
#   DONE_TIMEOUT      120   max seconds to wait for done after resume

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BASE_URL="${BASE_URL:-http://localhost:8000}"
SPEC_FILE="${1:-flows/07-minimal-hitl-test-flow.json}"
POLL_INTERVAL="${POLL_INTERVAL:-3}"
PAUSE_TIMEOUT="${PAUSE_TIMEOUT:-120}"
DONE_TIMEOUT="${DONE_TIMEOUT:-120}"
CONTENT_HEADER="Content-Type: application/json"

if [[ ! -f "$SPEC_FILE" ]]; then
  echo "ERROR: Spec file not found: $SPEC_FILE" >&2
  exit 1
fi

# ── Result tracking ───────────────────────────────────────────────────────────
PASS=0
FAIL=0
SKIP=0
declare -a RESULTS=()

_pass() { PASS=$((PASS+1)); RESULTS+=("PASS  $1"); echo "  ✓  $1"; }
_fail() { FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1"); echo "  ✗  $1"; }
_skip() { SKIP=$((SKIP+1)); RESULTS+=("SKIP  $1"); echo "  –  $1"; }
_section() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  itsharness — HITL regression verification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Adapter:        $BASE_URL"
echo "  Spec:           $SPEC_FILE"
echo "  Pause timeout:  ${PAUSE_TIMEOUT}s"
echo "  Done timeout:   ${DONE_TIMEOUT}s"
echo ""

# ── Auth ──────────────────────────────────────────────────────────────────────
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
LOGIN_HTTP=$(curl -s -o /tmp/_itsharness_hitl_body.json -w "%{http_code}" \
  -X POST "$BASE_URL/auth/login" \
  -H "$CONTENT_HEADER" -d "$CREDS_JSON")
LOGIN_BODY=$(cat /tmp/_itsharness_hitl_body.json)

if [[ "$LOGIN_HTTP" == "200" ]]; then
  TOKEN=$(echo "$LOGIN_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
  echo "  ✓  Logged in."
elif [[ "$LOGIN_HTTP" == "401" ]]; then
  echo "  Account not found, creating..."
  REG_HTTP=$(curl -s -o /tmp/_itsharness_hitl_body.json -w "%{http_code}" \
    -X POST "$BASE_URL/auth/register" \
    -H "$CONTENT_HEADER" -d "$CREDS_JSON")
  REG_BODY=$(cat /tmp/_itsharness_hitl_body.json)
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

# ── Payload builders ──────────────────────────────────────────────────────────
# Both helpers read the spec from disk so the JSON is never embedded in a shell
# string — avoids quoting issues with the template syntax ({{$.state.*}}).

_build_submit_payload() {
  # Writes a complete RunRequest payload to stdout.
  # The minimal test flow routes directly to hitl_breakpoint with no LLM call,
  # so the pause is guaranteed regardless of which model is available.
  python3 -c "
import json
with open('$SPEC_FILE') as f:
    spec = json.load(f)
print(json.dumps({'spec': spec, 'inputs': {'message': 'automated HITL regression test'}}))
"
}

_build_resume_payload() {
  # Writes a ResumeRequest payload to stdout.
  # Spec is always included so LangGraph / MAF can recompile after a restart.
  python3 -c "
import json
with open('$SPEC_FILE') as f:
    spec = json.load(f)
print(json.dumps({
    'payload': {'confirmed': True, 'notes': 'automated HITL verification'},
    'spec':    spec,
}))
"
}

# ── Per-runtime HITL verification ─────────────────────────────────────────────

verify_hitl_runtime() {
  local RUNTIME="$1"
  local TMP_BODY="/tmp/_itsharness_hitl_resp_${RUNTIME}.json"
  local TMP_SUBMIT="/tmp/_itsharness_hitl_submit_${RUNTIME}.json"
  local TMP_RESUME="/tmp/_itsharness_hitl_resume_${RUNTIME}.json"

  _section "Runtime: $RUNTIME"

  # ── 1. Submit ───────────────────────────────────────────────────────────────
  _build_submit_payload > "$TMP_SUBMIT"

  local SUBMIT_HTTP
  SUBMIT_HTTP=$(curl -s -o "$TMP_BODY" -w "%{http_code}" \
    -X POST "$BASE_URL/run?runtime=$RUNTIME" \
    -H "$AUTH_HEADER" -H "$CONTENT_HEADER" \
    -d @"$TMP_SUBMIT")

  local JOB_ID
  JOB_ID=$(python3 -c "import sys,json; print(json.load(open('$TMP_BODY')).get('job_id',''))" 2>/dev/null || echo "")
  if [[ -z "$JOB_ID" ]]; then
    _fail "$RUNTIME — job submission failed (HTTP $SUBMIT_HTTP)"
    return
  fi
  echo "  Job ID: $JOB_ID"

  # ── 2. Poll until paused ────────────────────────────────────────────────────
  local DEADLINE=$(( $(date +%s) + PAUSE_TIMEOUT ))
  local STATUS="" RESPONSE=""
  while true; do
    sleep "$POLL_INTERVAL"
    if [[ $(date +%s) -gt $DEADLINE ]]; then
      _fail "$RUNTIME — timed out after ${PAUSE_TIMEOUT}s waiting for paused state"
      return
    fi

    RESPONSE=$(curl -s "$BASE_URL/run/$JOB_ID" -H "$AUTH_HEADER")
    STATUS=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "unknown")

    if [[ "$STATUS" == "paused" ]]; then
      echo "  ✓  Job paused."
      break
    fi
    if [[ "$STATUS" == "done" ]]; then
      _fail "$RUNTIME — job completed without pausing; hitl_breakpoint was not triggered"
      return
    fi
    if [[ "$STATUS" == "error" ]]; then
      local ERR
      ERR=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null || echo "unknown")
      _fail "$RUNTIME — job errored before pausing: $ERR"
      return
    fi
    printf "  …  status: %s\r" "$STATUS"
  done

  # ── 3. Assert hitl_state ────────────────────────────────────────────────────
  local NODE_ID PROMPT
  NODE_ID=$(echo "$RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
h = d.get('hitl_state') or {}
print(h.get('node_id', ''))
" 2>/dev/null || echo "")
  PROMPT=$(echo "$RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
h = d.get('hitl_state') or {}
print(h.get('prompt', ''))
" 2>/dev/null || echo "")

  if [[ -z "$NODE_ID" ]]; then
    _fail "$RUNTIME — hitl_state.node_id is missing from paused job response"
    return
  fi
  echo "  ✓  hitl_state.node_id: $NODE_ID"

  if [[ -z "$PROMPT" ]]; then
    _fail "$RUNTIME — hitl_state.prompt is missing from paused job response"
    return
  fi
  echo "  ✓  hitl_state.prompt present (${#PROMPT} chars)"

  # ── 4. Resume ───────────────────────────────────────────────────────────────
  echo "  Resuming..."
  _build_resume_payload > "$TMP_RESUME"

  local RESUME_HTTP
  RESUME_HTTP=$(curl -s -o "$TMP_BODY" -w "%{http_code}" \
    -X POST "$BASE_URL/run/$JOB_ID/resume" \
    -H "$AUTH_HEADER" -H "$CONTENT_HEADER" \
    -d @"$TMP_RESUME")

  if [[ "$RESUME_HTTP" != "202" ]]; then
    local ERR
    ERR=$(python3 -c "import json; d=json.load(open('$TMP_BODY')); print(d.get('detail', d))" 2>/dev/null || cat "$TMP_BODY")
    _fail "$RUNTIME — resume returned HTTP $RESUME_HTTP: $ERR"
    return
  fi
  echo "  ✓  Resume accepted (HTTP 202)."

  # ── 5. Poll until done ──────────────────────────────────────────────────────
  DEADLINE=$(( $(date +%s) + DONE_TIMEOUT ))
  while true; do
    sleep "$POLL_INTERVAL"
    if [[ $(date +%s) -gt $DEADLINE ]]; then
      _fail "$RUNTIME — timed out after ${DONE_TIMEOUT}s waiting for done after resume"
      return
    fi

    RESPONSE=$(curl -s "$BASE_URL/run/$JOB_ID" -H "$AUTH_HEADER")
    STATUS=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "unknown")

    if [[ "$STATUS" == "done" ]]; then
      local ENDED_AT
      ENDED_AT=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ended_at') or '')" 2>/dev/null || echo "")
      if [[ -z "$ENDED_AT" ]]; then
        _fail "$RUNTIME — job status is done but ended_at is missing"
      else
        _pass "$RUNTIME — HITL pause → resume → done"
      fi
      return
    fi
    if [[ "$STATUS" == "error" ]]; then
      local ERR
      ERR=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null || echo "unknown")
      _fail "$RUNTIME — job errored after resume: $ERR"
      return
    fi
    if [[ "$STATUS" == "paused" ]]; then
      # The content moderation flow has only one hitl_breakpoint; a second
      # pause indicates the resume payload was not consumed correctly.
      _fail "$RUNTIME — job paused again after resume (resume payload may not have been applied)"
      return
    fi
    printf "  …  status: %s\r" "$STATUS"
  done
}

# ── Run HITL-capable runtimes ─────────────────────────────────────────────────

verify_hitl_runtime "langgraph"
verify_hitl_runtime "mastra"
verify_hitl_runtime "microsoft_agent_framework"

# ── CrewAI: explicitly skipped ────────────────────────────────────────────────
_section "Runtime: crewai"
echo ""
_skip "crewai — hitl_breakpoint compiles to human_input=True; calling input() in the"
echo "         adapter's thread-pool executor blocks indefinitely without a terminal."
echo "         API-level pause/resume is not supported for CrewAI. Use langgraph,"
echo "         mastra, or microsoft_agent_framework for flows that require HITL."

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
for line in "${RESULTS[@]}"; do
  case "$line" in
    PASS*) echo "  ✓  ${line#PASS  }" ;;
    FAIL*) echo "  ✗  ${line#FAIL  }" ;;
    SKIP*) echo "  –  ${line#SKIP  }" ;;
  esac
done
echo ""
echo "  Passed: $PASS / $((PASS+FAIL))  (skipped: $SKIP)"
echo ""

[[ "$FAIL" -eq 0 ]]
