#!/usr/bin/env bash
# run.sh — Trigger a flow run for any adapter and follow it to completion.
#
# Usage:
#   ./run.sh [--runtime <adapter>] <spec-file.json> [key=value ...]
#
# Arguments:
#   --runtime   crewai | langgraph | mastra | microsoft_agent_framework
#               If omitted, the spec's runtime_hints.preferred_adapter is used.
#               Falls back to langgraph when the hint is absent.
#
#   spec-file   Path to a JSON flow spec file.
#
#   key=value   Zero or more input key/value pairs passed as flow inputs.
#               Values are always strings; use a JSON file for typed inputs.
#               Example: topic="Cars in Germany" max_results=5
#
# Environment variables:
#   BASE_URL        API base URL (default: http://localhost:8000)
#   POLL_INTERVAL   Seconds between status polls (default: 2)
#   EMAIL / PASSWORD  Skip the interactive credential prompt.
#
# Examples:
#   ./run.sh flows/research-crew-flow.json
#   ./run.sh --runtime langgraph flows/research-crew-flow.json topic="Quantum computing"
#   ./run.sh --runtime crewai flows/research-crew-flow.json topic="Cars in Germany"

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Config ────────────────────────────────────────────────────────────────────
BASE_URL="${BASE_URL:-http://localhost:8000}"
POLL_INTERVAL="${POLL_INTERVAL:-2}"
CONTENT_HEADER="Content-Type: application/json"

RUNTIME=""
SPEC_FILE=""
declare -a KV_INPUTS=()

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime|-r)
      RUNTIME="$2"; shift 2 ;;
    --runtime=*|-r=*)
      RUNTIME="${1#*=}"; shift ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$SPEC_FILE" ]]; then
        SPEC_FILE="$1"
      else
        KV_INPUTS+=("$1")
      fi
      shift ;;
  esac
done

if [[ -z "$SPEC_FILE" ]]; then
  echo "Usage: $0 [--runtime <adapter>] <spec-file.json> [key=value ...]" >&2
  exit 1
fi

if [[ ! -f "$SPEC_FILE" ]]; then
  echo "ERROR: Spec file not found: $SPEC_FILE" >&2
  exit 1
fi

# ── Build inputs JSON from key=value pairs ────────────────────────────────────
INPUTS_JSON=$(python3 - "${KV_INPUTS[@]}" <<'EOF'
import sys, json
pairs = sys.argv[1:]
d = {}
for p in pairs:
    if '=' not in p:
        print(f"ERROR: input must be key=value, got: {p}", file=sys.stderr)
        sys.exit(1)
    k, _, v = p.partition('=')
    d[k.strip()] = v.strip()
print(json.dumps(d))
EOF
)

# ── Resolve runtime from spec hint if not given ───────────────────────────────
if [[ -z "$RUNTIME" ]]; then
  RUNTIME=$(python3 -c "
import json, sys
spec = json.load(open('$SPEC_FILE'))
print(spec.get('runtime_hints', {}).get('preferred_adapter', 'langgraph'))
" 2>/dev/null || echo "langgraph")
fi
RUNTIME=$(echo "$RUNTIME" | tr '[:upper:]' '[:lower:]')

VALID_RUNTIMES="crewai langgraph mastra microsoft_agent_framework"
if [[ ! " $VALID_RUNTIMES " =~ " $RUNTIME " ]]; then
  echo "ERROR: Unknown runtime '$RUNTIME'. Supported: $VALID_RUNTIMES" >&2
  exit 1
fi

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  buildaharness — flow runner"
echo "  runtime : $RUNTIME"
echo "  spec    : $SPEC_FILE"
if [[ "$INPUTS_JSON" != "{}" ]]; then
  echo "  inputs  : $INPUTS_JSON"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Credentials ───────────────────────────────────────────────────────────────
EMAIL="${EMAIL:-}"
PASSWORD="${PASSWORD:-}"

if [[ -z "$EMAIL" ]]; then
  echo ""
  printf "  Email:    "; read -r EMAIL
fi
if [[ -z "$PASSWORD" ]]; then
  printf "  Password: "; read -rs PASSWORD; echo ""
fi

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "ERROR: Email and password are required." >&2; exit 1
fi

CREDS_JSON=$(python3 -c "import json; print(json.dumps({'email': '$EMAIL', 'password': '$PASSWORD'}))")

# ── Login / auto-register ─────────────────────────────────────────────────────
echo ""
echo "  Signing in..."

LOGIN_STATUS=$(curl -s -o /tmp/_ih_body.json -w "%{http_code}" -X POST "$BASE_URL/auth/login" \
  -H "$CONTENT_HEADER" -d "$CREDS_JSON")
LOGIN_BODY=$(cat /tmp/_ih_body.json)

if [[ "$LOGIN_STATUS" == "200" ]]; then
  TOKEN=$(echo "$LOGIN_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
  echo "  ✓  Logged in."

elif [[ "$LOGIN_STATUS" == "401" ]]; then
  echo "  Account not found, creating..."
  REG_STATUS=$(curl -s -o /tmp/_ih_body.json -w "%{http_code}" -X POST "$BASE_URL/auth/register" \
    -H "$CONTENT_HEADER" -d "$CREDS_JSON")
  REG_BODY=$(cat /tmp/_ih_body.json)

  if [[ "$REG_STATUS" == "201" ]]; then
    TOKEN=$(echo "$REG_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
    echo "  ✓  Account created and logged in."
  elif [[ "$REG_STATUS" == "409" ]]; then
    echo "ERROR: Account exists but password is incorrect." >&2; exit 1
  else
    ERR=$(echo "$REG_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('detail',d))" 2>/dev/null || echo "$REG_BODY")
    echo "ERROR: Registration failed ($REG_STATUS): $ERR" >&2; exit 1
  fi

else
  ERR=$(echo "$LOGIN_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('detail',d))" 2>/dev/null || echo "$LOGIN_BODY")
  echo "ERROR: Login failed ($LOGIN_STATUS): $ERR" >&2; exit 1
fi

AUTH_HEADER="Authorization: Bearer $TOKEN"

# ── Submit job ────────────────────────────────────────────────────────────────
echo ""
echo "  Submitting..."

BODY=$(python3 -c "
import json, sys
spec   = json.load(open('$SPEC_FILE'))
inputs = json.loads('$INPUTS_JSON')
print(json.dumps({'spec': spec, 'inputs': inputs}))
")

SUBMIT_STATUS=$(curl -s -o /tmp/_ih_body.json -w "%{http_code}" \
  -X POST "$BASE_URL/run?runtime=$RUNTIME" \
  -H "$AUTH_HEADER" -H "$CONTENT_HEADER" -d "$BODY")
SUBMIT_BODY=$(cat /tmp/_ih_body.json)

if [[ "$SUBMIT_STATUS" != "202" ]]; then
  ERR=$(echo "$SUBMIT_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('detail',d))" 2>/dev/null || echo "$SUBMIT_BODY")
  echo "ERROR: Submit failed ($SUBMIT_STATUS): $ERR" >&2; exit 1
fi

JOB_ID=$(echo "$SUBMIT_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])" 2>/dev/null)
if [[ -z "$JOB_ID" ]]; then
  echo "ERROR: No job_id in response: $SUBMIT_BODY" >&2; exit 1
fi

echo "  Job ID: $JOB_ID"
echo ""

# ── Poll loop ─────────────────────────────────────────────────────────────────
LAST_EVENT_COUNT=0

while true; do
  sleep "$POLL_INTERVAL"

  RESPONSE=$(curl -s "$BASE_URL/run/$JOB_ID" -H "$AUTH_HEADER")
  STATUS=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "unknown")
  EVENT_COUNT=$(echo "$RESPONSE" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('node_events',[])))" 2>/dev/null || echo 0)

  if [[ "$EVENT_COUNT" -gt "$LAST_EVENT_COUNT" ]]; then
    PREV=$LAST_EVENT_COUNT
    printf '%s' "$RESPONSE" | python3 -c "
import sys, json
prev   = int('$PREV')
data   = json.load(sys.stdin)
events = data.get('node_events', [])
icons  = {'pending': '○', 'running': '▶', 'done': '✓', 'paused': '⏸', 'error': '✗'}
for ev in events[prev:]:
    icon = icons.get(ev['status'], '?')
    ms   = f\" ({ev['ms']}ms)\" if ev.get('ms') is not None else ''
    tok  = f\" [{ev['tokens']} tok]\" if ev.get('tokens') else ''
    err  = f\"\n    {ev['error_message']}\" if ev.get('error_message') else ''
    print(f\"  {icon}  {ev['node_id']:<30} {ev['status']}{ms}{tok}{err}\")
"
    LAST_EVENT_COUNT="$EVENT_COUNT"
  fi

  # ── Done ──────────────────────────────────────────────────────────────────
  if [[ "$STATUS" == "done" ]]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✓  Completed"
    TRACE_URL=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('trace_url') or '')" 2>/dev/null || true)
    [[ -n "$TRACE_URL" ]] && echo "  Langfuse: $TRACE_URL"
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

  # ── Error ─────────────────────────────────────────────────────────────────
  if [[ "$STATUS" == "error" ]]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✗  Failed"
    TRACE_URL=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('trace_url') or '')" 2>/dev/null || true)
    [[ -n "$TRACE_URL" ]] && echo "  Langfuse: $TRACE_URL"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown error'))"
    echo ""
    exit 1
  fi

  # ── HITL pause ────────────────────────────────────────────────────────────
  if [[ "$STATUS" == "paused" ]]; then
    if [[ "$RUNTIME" == "crewai" ]]; then
      echo ""
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo "  ✗  Unexpected paused state — CrewAI does not support API-level HITL"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      exit 1
    fi

    NODE_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('hitl_state',{}).get('node_id','unknown'))" 2>/dev/null || echo "unknown")
    PROMPT=$(echo "$RESPONSE"  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('hitl_state',{}).get('prompt','Provide input as JSON.'))" 2>/dev/null || echo "")

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ⏸  Human input required — node: $NODE_ID"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    [[ -n "$PROMPT" ]] && echo "  $PROMPT"
    echo "  Enter your response as a JSON object (Ctrl+C to abort)."
    echo ""

    while true; do
      printf "  Response: "
      read -r USER_INPUT
      if echo "$USER_INPUT" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
        break
      fi
      echo "  Not valid JSON — try again."
    done

    echo ""
    echo "  Resuming..."

    RESUME_BODY=$(python3 -c "
import json, sys
spec   = json.load(open('$SPEC_FILE'))
hitl   = json.loads('$USER_INPUT')
print(json.dumps({'hitl_response': hitl, 'spec': spec}))
")

    RESUME_STATUS=$(curl -s -o /tmp/_ih_body.json -w "%{http_code}" \
      -X POST "$BASE_URL/run/$JOB_ID/resume" \
      -H "$AUTH_HEADER" -H "$CONTENT_HEADER" -d "$RESUME_BODY")
    RESUME_BODY_OUT=$(cat /tmp/_ih_body.json)

    if [[ "$RESUME_STATUS" != "202" ]]; then
      ERR=$(echo "$RESUME_BODY_OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('detail',d))" 2>/dev/null || echo "$RESUME_BODY_OUT")
      echo "ERROR: Resume failed ($RESUME_STATUS): $ERR" >&2; exit 1
    fi

    echo "  ✓  Resumed. Continuing..."
    echo ""
    LAST_EVENT_COUNT=0
  fi

done
