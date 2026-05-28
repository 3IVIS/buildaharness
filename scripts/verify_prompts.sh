#!/usr/bin/env bash
# verify_prompts.sh — Confirms Langfuse-managed prompt templates are reachable
# from the adapter through every code path.
#
# Three independent paths are tested — each can fail independently:
#
#   Layer 1  Langfuse direct       Create + fetch via /api/public/prompts (Basic auth)
#   Layer 2  Adapter HTTP proxy    GET /prompts and GET /prompts/{name} (Bearer JWT)
#                                  proxies Langfuse HTTP — a separate path from the SDK
#   Layer 3  Adapter SDK resolve   POST /run with prompt_ref in spec; the adapter
#                                  calls langfuse.get_prompt() (Python SDK) before
#                                  the job executes — detects SDK credential failure
#                                  that the HTTP proxy cannot catch
#
# Layer 3 uses a sentinel fallback: the spec sets prompt_template="UNRESOLVED".
# If resolution succeeds the LLM is told "Reply with exactly one word: VERIFIED"
# and the result contains "VERIFIED". If it fails silently the result contains
# "UNRESOLVED" or something unrelated — clearly distinguishable.
#
# Usage:
#   ./verify_prompts.sh
#
# Non-interactive / CI mode:
#   TEST_EMAIL=ci@example.com TEST_PASSWORD=CiPass99! ./verify_prompts.sh
#
# Environment (all optional — defaults shown):
#   BASE_URL            http://localhost:8000
#   LANGFUSE_URL        http://localhost:3001
#   LANGFUSE_PUBLIC_KEY read from .env
#   LANGFUSE_SECRET_KEY read from .env
#   OPENAI_BASE_URL     read from .env — controls model name used in resolve flow
#   MODEL               mistral:latest  (Ollama model, used if OPENAI_BASE_URL → Ollama)
#   POLL_INTERVAL       3    seconds between job status polls
#   RESOLVE_TIMEOUT     90   max seconds to wait for the resolve flow job

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BASE_URL="${BASE_URL:-http://localhost:8000}"
LANGFUSE_URL="${LANGFUSE_URL:-http://localhost:3001}"
POLL_INTERVAL="${POLL_INTERVAL:-3}"
RESOLVE_TIMEOUT="${RESOLVE_TIMEOUT:-90}"
CONTENT_HEADER="Content-Type: application/json"

# Stable name — re-running the script creates a new version in Langfuse (idempotent).
TEST_PROMPT_NAME="itsharness-prompt-verify"
# Sentinel text: LLM output "VERIFIED" means the SDK resolved the prompt correctly.
TEST_PROMPT_TEXT="Reply with exactly one word: VERIFIED"
# Sentinel fallback in the spec: if this appears in the result, resolution failed.
UNRESOLVED_SENTINEL="UNRESOLVED"

TMPDIR_IH=$(mktemp -d)
trap 'rm -rf "$TMPDIR_IH"' EXIT

# ── Load .env values ──────────────────────────────────────────────────────────
_env_val() {
  local key="$1" default="${2:-}"
  local val="${!key:-}"
  if [[ -z "$val" && -f ".env" ]]; then
    val=$(grep -E "^${key}=" .env | head -1 | cut -d= -f2-)
  fi
  echo "${val:-$default}"
}

LANGFUSE_PUBLIC_KEY=$(_env_val LANGFUSE_PUBLIC_KEY)
LANGFUSE_SECRET_KEY=$(_env_val LANGFUSE_SECRET_KEY)
OPENAI_BASE_URL_EFF=$(_env_val OPENAI_BASE_URL "http://litellm:4000")
MODEL="${MODEL:-mistral:latest}"

# Pick the model name the adapter will recognise at its OPENAI_BASE_URL.
if echo "$OPENAI_BASE_URL_EFF" | grep -qE "11434|ollama"; then
  FLOW_MODEL="$MODEL"
else
  FLOW_MODEL="${MODEL%%:*}"  # LiteLLM alias (strip :latest)
fi

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
echo "  itsharness — Prompt management verification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Adapter:     $BASE_URL"
echo "  Langfuse:    $LANGFUSE_URL"
echo "  Test prompt: $TEST_PROMPT_NAME"
echo "  Flow model:  $FLOW_MODEL"
echo ""

# ── Preflight ─────────────────────────────────────────────────────────────────
_section "Preflight"

if [[ -z "$LANGFUSE_PUBLIC_KEY" || -z "$LANGFUSE_SECRET_KEY" ]]; then
  echo "  ✗  LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set in env or .env" >&2
  echo "     Layers 1 and 2 require Langfuse credentials." >&2
  exit 1
fi
echo "  ✓  Langfuse keys present"

LF_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
  "$LANGFUSE_URL/api/public/health" 2>/dev/null || echo "000")
if [[ "$LF_HEALTH" != "200" ]]; then
  echo "  ✗  Langfuse not reachable at $LANGFUSE_URL (HTTP $LF_HEALTH)" >&2
  exit 1
fi
echo "  ✓  Langfuse reachable"

ADAPTER_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
  "$BASE_URL/health" 2>/dev/null || echo "000")
if [[ "$ADAPTER_HEALTH" != "200" ]]; then
  echo "  ✗  Adapter not reachable at $BASE_URL (HTTP $ADAPTER_HEALTH)" >&2
  exit 1
fi
echo "  ✓  Adapter reachable"

LF_AUTH_HEADER="-u ${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}"

# ── Layer 1: Langfuse direct ──────────────────────────────────────────────────
_section "Layer 1 — Langfuse direct ($LANGFUSE_URL)"

# 1a. Create (or add a new version of) the test prompt.
CREATE_PAYLOAD=$(python3 -c "
import json
print(json.dumps({
    'name':     '$TEST_PROMPT_NAME',
    'prompt':   '$TEST_PROMPT_TEXT',
    'labels':   ['production'],
    'isActive': True,
}))
")
CREATE_HTTP=$(curl -s -o "${TMPDIR_IH}/lf_create.json" -w "%{http_code}" \
  -X POST \
  -u "${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}" \
  -H "$CONTENT_HEADER" \
  -d "$CREATE_PAYLOAD" \
  "$LANGFUSE_URL/api/public/prompts")

if [[ "$CREATE_HTTP" == "201" ]]; then
  VERSION=$(python3 -c "import json; print(json.load(open('${TMPDIR_IH}/lf_create.json')).get('version','?'))" 2>/dev/null || echo "?")
  _pass "Langfuse — created test prompt '$TEST_PROMPT_NAME' (version $VERSION)"
else
  ERR=$(python3 -c "import json; d=json.load(open('${TMPDIR_IH}/lf_create.json')); print(d.get('message', d))" 2>/dev/null || cat "${TMPDIR_IH}/lf_create.json")
  _fail "Langfuse — prompt creation returned HTTP $CREATE_HTTP: $ERR"
fi

# 1b. Fetch by name and verify the text round-trips correctly.
FETCH_HTTP=$(curl -s -o "${TMPDIR_IH}/lf_fetch.json" -w "%{http_code}" \
  -u "${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}" \
  "$LANGFUSE_URL/api/public/prompts?name=${TEST_PROMPT_NAME}")

if [[ "$FETCH_HTTP" != "200" ]]; then
  _fail "Langfuse — fetch '$TEST_PROMPT_NAME' returned HTTP $FETCH_HTTP"
else
  FETCHED_TEXT=$(python3 -c "import json; print(json.load(open('${TMPDIR_IH}/lf_fetch.json')).get('prompt',''))" 2>/dev/null || echo "")
  if [[ "$FETCHED_TEXT" == "$TEST_PROMPT_TEXT" ]]; then
    _pass "Langfuse — fetched prompt text matches exactly"
  elif [[ -n "$FETCHED_TEXT" ]]; then
    _fail "Langfuse — fetched text differs: got '${FETCHED_TEXT:0:80}'"
  else
    _fail "Langfuse — fetched prompt but text is empty"
  fi
fi

# 1c. List all prompts and confirm the test prompt is present.
LIST_HTTP=$(curl -s -o "${TMPDIR_IH}/lf_list.json" -w "%{http_code}" \
  -u "${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}" \
  "$LANGFUSE_URL/api/public/v2/prompts?limit=100")

if [[ "$LIST_HTTP" != "200" ]]; then
  _fail "Langfuse — list prompts returned HTTP $LIST_HTTP"
else
  FOUND=$(python3 -c "
import json
data = json.load(open('${TMPDIR_IH}/lf_list.json'))
names = [p['name'] for p in data.get('data', [])]
print('yes' if '$TEST_PROMPT_NAME' in names else 'no')
" 2>/dev/null || echo "no")
  if [[ "$FOUND" == "yes" ]]; then
    TOTAL=$(python3 -c "import json; print(json.load(open('${TMPDIR_IH}/lf_list.json')).get('meta',{}).get('totalItems','?'))" 2>/dev/null || echo "?")
    _pass "Langfuse — '$TEST_PROMPT_NAME' appears in prompt list ($TOTAL total)"
  else
    _fail "Langfuse — '$TEST_PROMPT_NAME' not found in prompt list"
  fi
fi

# ── Auth for adapter layers ───────────────────────────────────────────────────
_section "Authentication"

if [[ -n "${TEST_EMAIL:-}" && -n "${TEST_PASSWORD:-}" ]]; then
  EMAIL="$TEST_EMAIL"
  PASSWORD="$TEST_PASSWORD"
  echo "  Using TEST_EMAIL / TEST_PASSWORD from environment."
else
  printf "  Email:    "
  read -r EMAIL
  printf "  Password: "
  read -rs PASSWORD
  echo ""
fi
echo ""

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "  ✗  Email and password required for Layers 2 and 3." >&2
  exit 1
fi

CREDS=$(python3 -c "
import json, sys
print(json.dumps({'email': sys.argv[1], 'password': sys.argv[2]}))" "$EMAIL" "$PASSWORD")

echo "  Signing in..."
LOGIN_HTTP=$(curl -s -o "${TMPDIR_IH}/auth.json" -w "%{http_code}" \
  -X POST "$BASE_URL/auth/login" -H "$CONTENT_HEADER" -d "$CREDS")

if [[ "$LOGIN_HTTP" == "200" ]]; then
  TOKEN=$(python3 -c "import json; print(json.load(open('${TMPDIR_IH}/auth.json'))['token'])")
  echo "  ✓  Logged in."
elif [[ "$LOGIN_HTTP" == "401" ]]; then
  echo "  Account not found, creating..."
  REG_HTTP=$(curl -s -o "${TMPDIR_IH}/auth.json" -w "%{http_code}" \
    -X POST "$BASE_URL/auth/register" -H "$CONTENT_HEADER" -d "$CREDS")
  if [[ "$REG_HTTP" == "201" ]]; then
    TOKEN=$(python3 -c "import json; print(json.load(open('${TMPDIR_IH}/auth.json'))['token'])")
    echo "  ✓  Registered and logged in."
  elif [[ "$REG_HTTP" == "409" ]]; then
    echo "  ✗  Account exists but password is incorrect." >&2; exit 1
  else
    ERR=$(python3 -c "import json; d=json.load(open('${TMPDIR_IH}/auth.json')); print(d.get('detail',d))" 2>/dev/null || cat "${TMPDIR_IH}/auth.json")
    echo "  ✗  Registration failed ($REG_HTTP): $ERR" >&2; exit 1
  fi
else
  ERR=$(python3 -c "import json; d=json.load(open('${TMPDIR_IH}/auth.json')); print(d.get('detail',d))" 2>/dev/null || cat "${TMPDIR_IH}/auth.json")
  echo "  ✗  Login failed ($LOGIN_HTTP): $ERR" >&2; exit 1
fi

AUTH_HEADER="Authorization: Bearer $TOKEN"

# ── Layer 2: Adapter HTTP proxy ───────────────────────────────────────────────
_section "Layer 2 — Adapter HTTP proxy ($BASE_URL/prompts)"

# 2a. List prompts via adapter.
LIST2_HTTP=$(curl -s -o "${TMPDIR_IH}/adapter_list.json" -w "%{http_code}" \
  "$BASE_URL/prompts" -H "$AUTH_HEADER")

if [[ "$LIST2_HTTP" != "200" ]]; then
  ERR=$(python3 -c "import json; d=json.load(open('${TMPDIR_IH}/adapter_list.json')); print(d.get('detail',d))" 2>/dev/null || cat "${TMPDIR_IH}/adapter_list.json")
  _fail "Adapter list — GET /prompts returned HTTP $LIST2_HTTP: $ERR"
else
  FOUND2=$(python3 -c "
import json
data = json.load(open('${TMPDIR_IH}/adapter_list.json'))
names = [p['name'] for p in (data if isinstance(data, list) else [])]
print('yes' if '$TEST_PROMPT_NAME' in names else 'no')
" 2>/dev/null || echo "no")
  if [[ "$FOUND2" == "yes" ]]; then
    _pass "Adapter list — '$TEST_PROMPT_NAME' present in GET /prompts"
  else
    _fail "Adapter list — '$TEST_PROMPT_NAME' not found in GET /prompts response"
  fi
fi

# 2b. Fetch by name via adapter.
FETCH2_HTTP=$(curl -s -o "${TMPDIR_IH}/adapter_fetch.json" -w "%{http_code}" \
  "$BASE_URL/prompts/$TEST_PROMPT_NAME" -H "$AUTH_HEADER")

if [[ "$FETCH2_HTTP" != "200" ]]; then
  ERR=$(python3 -c "import json; d=json.load(open('${TMPDIR_IH}/adapter_fetch.json')); print(d.get('detail',d))" 2>/dev/null || cat "${TMPDIR_IH}/adapter_fetch.json")
  _fail "Adapter fetch — GET /prompts/$TEST_PROMPT_NAME returned HTTP $FETCH2_HTTP: $ERR"
else
  FETCHED2=$(python3 -c "import json; print(json.load(open('${TMPDIR_IH}/adapter_fetch.json')).get('prompt',''))" 2>/dev/null || echo "")
  if [[ "$FETCHED2" == "$TEST_PROMPT_TEXT" ]]; then
    _pass "Adapter fetch — prompt text matches"
  elif [[ -n "$FETCHED2" ]]; then
    _fail "Adapter fetch — text differs: got '${FETCHED2:0:80}'"
  else
    _fail "Adapter fetch — prompt text is empty"
  fi
fi

# ── Layer 3: Adapter SDK resolve in flow ──────────────────────────────────────
_section "Layer 3 — Adapter SDK resolve in flow (langgraph, model: $FLOW_MODEL)"

echo "  Submitting flow with prompt_ref: {name: \"$TEST_PROMPT_NAME\"}..."
echo "  Fallback prompt_template is \"$UNRESOLVED_SENTINEL\" — will be overwritten if SDK resolves."
echo ""

# Build a minimal spec with an llm_call node that uses prompt_ref.
# prompt_template is set to the UNRESOLVED sentinel so a silent fallback is detectable.
python3 - "$FLOW_MODEL" "$TEST_PROMPT_NAME" "$UNRESOLVED_SENTINEL" > "${TMPDIR_IH}/resolve_submit.json" <<'PYEOF'
import json, sys
flow_model, prompt_name, sentinel = sys.argv[1], sys.argv[2], sys.argv[3]
spec = {
    "spec_version": "0.2.0",
    "id":           "prompt-resolve-test",
    "name":         "Prompt Resolve Test",
    "model_defaults": {"model": flow_model},
    "state_schema": {
        "type": "object",
        "properties": {"response": {"type": "string"}},
        "required": [],
    },
    "nodes": [
        {"id": "start",  "type": "input",  "label": "Input"},
        {
            "id":              "check",
            "type":            "llm_call",
            "label":           "Prompt resolve check",
            "model":           flow_model,
            "prompt_ref":      {"name": prompt_name, "label": "production"},
            "prompt_template": sentinel,
            "output_key":      "response",
        },
        {"id": "done",   "type": "output", "label": "Output"},
    ],
    "edges": [
        {"type": "direct", "from": "start",  "to": "check"},
        {"type": "direct", "from": "check",  "to": "done"},
    ],
}
print(json.dumps({"spec": spec, "inputs": {}}))
PYEOF

SUBMIT_HTTP=$(curl -s -o "${TMPDIR_IH}/resolve_resp.json" -w "%{http_code}" \
  -X POST "$BASE_URL/run?runtime=langgraph" \
  -H "$AUTH_HEADER" -H "$CONTENT_HEADER" \
  -d @"${TMPDIR_IH}/resolve_submit.json")

JOB_ID=$(python3 -c "import json; print(json.load(open('${TMPDIR_IH}/resolve_resp.json')).get('job_id',''))" 2>/dev/null || echo "")
if [[ -z "$JOB_ID" ]]; then
  ERR=$(python3 -c "import json; d=json.load(open('${TMPDIR_IH}/resolve_resp.json')); print(d.get('detail',d))" 2>/dev/null || cat "${TMPDIR_IH}/resolve_resp.json")
  _fail "Adapter resolve — job submission failed (HTTP $SUBMIT_HTTP): $ERR"
else
  echo "  Job ID: $JOB_ID"

  DEADLINE=$(( $(date +%s) + RESOLVE_TIMEOUT ))
  FINAL_POLL=""
  while true; do
    sleep "$POLL_INTERVAL"
    if [[ $(date +%s) -gt $DEADLINE ]]; then
      _fail "Adapter resolve — timed out after ${RESOLVE_TIMEOUT}s"
      break
    fi
    POLL=$(curl -s "$BASE_URL/run/$JOB_ID" -H "$AUTH_HEADER")
    STATUS=$(echo "$POLL" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "unknown")

    if [[ "$STATUS" == "done" ]]; then
      FINAL_POLL="$POLL"
      break
    fi
    if [[ "$STATUS" == "error" ]]; then
      ERR=$(echo "$POLL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null || echo "unknown")
      _fail "Adapter resolve — job errored: $ERR"
      break
    fi
    printf "  …  status: %s\r" "$STATUS"
  done

  if [[ -n "$FINAL_POLL" ]]; then
    # Extract the LLM response from the final state JSON.
    LLM_OUTPUT=$(echo "$FINAL_POLL" | python3 -c "
import sys, json
try:
    job = json.load(sys.stdin)
    raw = job.get('result', '') or ''
    # result is json.dumps(final_state) for LangGraph
    state = json.loads(raw) if raw.startswith('{') else {}
    print(state.get('response', raw)[:300])
except Exception:
    print('')
" 2>/dev/null || echo "")

    echo "  LLM output: ${LLM_OUTPUT:0:120}"

    LLM_LOWER=$(echo "$LLM_OUTPUT" | tr '[:upper:]' '[:lower:]')
    SENTINEL_LOWER=$(echo "$UNRESOLVED_SENTINEL" | tr '[:upper:]' '[:lower:]')

    if echo "$LLM_LOWER" | grep -q "verified"; then
      _pass "Adapter resolve — SDK resolved prompt; LLM output contains 'VERIFIED'"
    elif echo "$LLM_LOWER" | grep -q "$SENTINEL_LOWER"; then
      _fail "Adapter resolve — prompt_template sentinel '$UNRESOLVED_SENTINEL' reached the LLM; SDK resolution failed silently"
      echo "  Hint: check LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY in the adapter container env."
    elif [[ -z "$LLM_OUTPUT" ]]; then
      _fail "Adapter resolve — LLM output is empty (silent failure in LLM call or resolve)"
    else
      # Non-empty but not "VERIFIED" — resolution likely worked but LLM didn't follow instruction exactly.
      _pass "Adapter resolve — non-empty output (LLM did not say 'VERIFIED' verbatim but sentinel absent)"
      echo "  Note: confirm manually that the LLM received the resolved prompt, not the sentinel."
    fi
  fi
fi

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
  echo "  Diagnostic guide:"
  echo "    Layer 1 failed → Langfuse API unreachable or keys wrong"
  echo "    Layer 2 failed → adapter HTTP proxy broken (check prompts_api.py)"
  echo "    Layer 3 failed → Langfuse SDK can't resolve (check adapter LANGFUSE_* env vars)"
  echo "    Layer 2 ok, Layer 3 fails → HTTP proxy and SDK use different auth paths"
  echo ""
fi

[[ "$FAIL" -eq 0 ]]
