#!/usr/bin/env bash
# run_langgraph.sh — Submit a LangGraph job, handle HITL pauses, and follow to completion.
#
# Usage:
#   ./run_langgraph.sh flow-plan-execute.json
#
# Prompts for email + password, logs in (or auto-registers if the account
# doesn't exist yet), then runs the job end-to-end.

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Config ────────────────────────────────────────────────────────────────────
BASE_URL="${BASE_URL:-http://localhost:8000}"
SPEC_FILE="${1:-flow-plan-execute.json}"
POLL_INTERVAL="${POLL_INTERVAL:-2}"

if [[ ! -f "$SPEC_FILE" ]]; then
  echo "ERROR: Spec file not found: $SPEC_FILE" >&2
  exit 1
fi

CONTENT_HEADER="Content-Type: application/json"

# ── 1. Credentials prompt ─────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  buildaharness — LangGraph runner"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
printf "  Email:    "
read -r EMAIL
printf "  Password: "
read -rs PASSWORD
echo ""

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "ERROR: Email and password are required." >&2
  exit 1
fi

CREDS_JSON=$(python3 -c "import json; print(json.dumps({'email': '$EMAIL', 'password': '$PASSWORD'}))")

# ── 2. Try login first ────────────────────────────────────────────────────────
echo ""
echo "  Signing in..."

LOGIN_BODY=$(curl -s -o /tmp/_buildaharness_body.json -w "%{http_code}" -X POST "$BASE_URL/auth/login" \
  -H "$CONTENT_HEADER" \
  -d "$CREDS_JSON")
LOGIN_STATUS="$LOGIN_BODY"
LOGIN_BODY=$(cat /tmp/_buildaharness_body.json)

if [[ "$LOGIN_STATUS" == "200" ]]; then
  TOKEN=$(echo "$LOGIN_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
  echo "  ✓  Logged in."

elif [[ "$LOGIN_STATUS" == "401" ]]; then
  # User likely doesn't exist — try to register
  echo "  Account not found, creating..."

  REGISTER_STATUS=$(curl -s -o /tmp/_buildaharness_body.json -w "%{http_code}" -X POST "$BASE_URL/auth/register" \
    -H "$CONTENT_HEADER" \
    -d "$CREDS_JSON")
  REGISTER_BODY=$(cat /tmp/_buildaharness_body.json)

  if [[ "$REGISTER_STATUS" == "201" ]]; then
    TOKEN=$(echo "$REGISTER_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
    echo "  ✓  Account created and logged in."

  elif [[ "$REGISTER_STATUS" == "409" ]]; then
    # Account exists but password was wrong
    echo "ERROR: Account exists but password is incorrect." >&2
    exit 1

  else
    ERR=$(echo "$REGISTER_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('detail', d))" 2>/dev/null || echo "$REGISTER_BODY")
    echo "ERROR: Registration failed ($REGISTER_STATUS): $ERR" >&2
    exit 1
  fi

else
  ERR=$(echo "$LOGIN_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('detail', d))" 2>/dev/null || echo "$LOGIN_BODY")
  echo "ERROR: Login failed ($LOGIN_STATUS): $ERR" >&2
  exit 1
fi

AUTH_HEADER="Authorization: Bearer $TOKEN"

# ── 3. Submit job ─────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Submitting job: $SPEC_FILE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

SUBMIT_RESPONSE=$(curl -s -X POST "$BASE_URL/run?runtime=langgraph" \
  -H "$AUTH_HEADER" \
  -H "$CONTENT_HEADER" \
  -d "{\"spec\": $(cat "$SPEC_FILE")}")

JOB_ID=$(echo "$SUBMIT_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])" 2>/dev/null)
if [[ -z "$JOB_ID" ]]; then
  echo "ERROR: Could not extract job_id. Response:" >&2
  echo "$SUBMIT_RESPONSE" >&2
  exit 1
fi

echo "  Job ID: $JOB_ID"
echo ""

# ── 4. Poll loop ──────────────────────────────────────────────────────────────
LAST_EVENT_COUNT=0

while true; do
  sleep "$POLL_INTERVAL"

  RESPONSE=$(curl -s "$BASE_URL/run/$JOB_ID" -H "$AUTH_HEADER")
  STATUS=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
  EVENT_COUNT=$(echo "$RESPONSE" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('node_events', [])))" 2>/dev/null || echo 0)

  # Print any new node events
  if [[ "$EVENT_COUNT" -gt "$LAST_EVENT_COUNT" ]]; then
    LAST_N=$LAST_EVENT_COUNT
    echo "$RESPONSE" | python3 -c "
import sys, json, os
data = json.load(sys.stdin)
events = data.get('node_events', [])
last = int('$LAST_N')
icons = {'pending': '○', 'running': '▶', 'done': '✓', 'paused': '⏸', 'error': '✗'}
for ev in events[last:]:
    icon = icons.get(ev['status'], '?')
    ms = f\" ({ev['ms']}ms)\" if ev.get('ms') is not None else ''
    print(f\"  {icon}  {ev['node_id']:<30} {ev['status']}{ms}\")
"
    LAST_EVENT_COUNT="$EVENT_COUNT"
  fi

  # ── Done ────────────────────────────────────────────────────────────────
  if [[ "$STATUS" == "done" ]]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✓  Completed"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "$RESPONSE" | python3 -c "
import sys, json
result = json.load(sys.stdin).get('result', '')
print(result if result else '(no result)')
"
    echo ""
    exit 0
  fi

  # ── Error ───────────────────────────────────────────────────────────────
  if [[ "$STATUS" == "error" ]]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✗  Failed"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown error'))"
    echo ""
    exit 1
  fi

  # ── HITL pause ───────────────────────────────────────────────────────────
  if [[ "$STATUS" == "paused" ]]; then
    HITL=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('hitl_state') or {}))")
    NODE_ID=$(echo "$HITL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('node_id','?'))")
    PROMPT=$(echo "$HITL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('prompt',''))" | sed 's/{{[^}]*}}/(value from spec)/g')

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ⏸  Human input required — node: $NODE_ID"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "$PROMPT"
    echo ""
    echo "  Enter your response as a JSON object."
    echo "  Example: {\"success_criteria\": \"working demo\", \"constraints\": \"none\", \"has_human_steps\": false}"
    echo "  Press Ctrl+C to abort."
    echo ""
    printf "  Response: "
    read -r USER_INPUT

    if ! echo "$USER_INPUT" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
      echo "ERROR: Not valid JSON. Please try again." >&2
      STATUS="running"
      continue
    fi

    echo ""
    echo "  Resuming..."

    # LangGraph resume: pass both payload and the original spec (needed if server restarted)
    SPEC_CONTENT=$(cat "$SPEC_FILE")
    RESUME_HTTP=$(curl -s -o /tmp/_buildaharness_body.json -w "%{http_code}" -X POST "$BASE_URL/run/$JOB_ID/resume" \
      -H "$AUTH_HEADER" \
      -H "$CONTENT_HEADER" \
      -d "{\"payload\": $USER_INPUT, \"spec\": $SPEC_CONTENT}")
    RESUME_BODY=$(cat /tmp/_buildaharness_body.json)

    if [[ "$RESUME_HTTP" != "202" ]]; then
      ERR=$(echo "$RESUME_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('detail', d))" 2>/dev/null || echo "$RESUME_BODY")
      echo "ERROR: Resume failed ($RESUME_HTTP): $ERR" >&2
      exit 1
    fi

    echo "  ✓  Resumed. Continuing..."
    echo ""
    continue
  fi

done
