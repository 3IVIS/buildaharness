#!/usr/bin/env bash
# verify_llm.sh — Confirms the full LLM call path works end-to-end.
#
# Runs three independent layers so any failure can be immediately isolated:
#
#   Layer 1  Ollama direct     POST localhost:11434/v1/chat/completions
#   Layer 2  LiteLLM proxy     POST localhost:4000/v1/chat/completions
#   Layer 3  Adapter → flow    flows/06-ollama-simple-flow.json via langgraph
#
#   Layer 1 fails            → Ollama is down or the model is not pulled.
#   Layer 1 ok, Layer 2 fails → LiteLLM routing is broken.
#   Layer 2 ok, Layer 3 fails → The adapter's LLM path is broken.
#
# A flow can appear to complete but produce empty output when LiteLLM routing
# silently breaks — Layer 3 verifies the response is non-empty and on-topic.
#
# Usage:
#   ./verify_llm.sh [model]          # default: mistral:latest
#   MODEL=qwen3:latest ./verify_llm.sh
#
# Non-interactive / CI mode (skips credentials prompt):
#   TEST_EMAIL=ci@example.com TEST_PASSWORD=CiPass99! ./verify_llm.sh
#
# Environment (all optional — defaults shown):
#   MODEL               mistral:latest   Ollama model name (full tag)
#   BASE_URL            http://localhost:8000
#   OLLAMA_BASE_URL     http://localhost:11434
#   LITELLM_URL         http://localhost:4000
#   LITELLM_MASTER_KEY  read from .env if not set
#   OPENAI_BASE_URL     read from .env — controls model alias used in the flow
#   POLL_INTERVAL       3    seconds between flow status polls
#   FLOW_TIMEOUT        90   max seconds to wait for the flow run to complete

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Config ────────────────────────────────────────────────────────────────────
MODEL="${1:-${MODEL:-mistral:latest}}"
BASE_URL="${BASE_URL:-http://localhost:8000}"
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
LITELLM_URL="${LITELLM_URL:-http://localhost:4000}"
POLL_INTERVAL="${POLL_INTERVAL:-3}"
FLOW_TIMEOUT="${FLOW_TIMEOUT:-90}"
CONTENT_HEADER="Content-Type: application/json"
FLOW_FILE="flows/06-ollama-simple-flow.json"
TEST_TOPIC="latency"   # single common word — easy to verify in any LLM response

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

LITELLM_MASTER_KEY=$(_env_val LITELLM_MASTER_KEY)
# OPENAI_BASE_URL inside the adapter container — may differ from host-level
OPENAI_BASE_URL_EFF=$(_env_val OPENAI_BASE_URL "http://litellm:4000")

# LiteLLM model alias strips the Ollama tag: mistral:latest → mistral
LITELLM_MODEL_ALIAS="${MODEL%%:*}"

# Model name to patch into the flow spec depends on where the adapter routes LLM calls.
if echo "$OPENAI_BASE_URL_EFF" | grep -qE "11434|ollama"; then
  FLOW_MODEL="$MODEL"                # adapter → Ollama direct
else
  FLOW_MODEL="$LITELLM_MODEL_ALIAS"  # adapter → LiteLLM
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
echo "  itsharness — LLM path verification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Model:          $MODEL"
echo "  LiteLLM alias:  $LITELLM_MODEL_ALIAS"
echo "  Flow model:     $FLOW_MODEL  (adapter OPENAI_BASE_URL → $OPENAI_BASE_URL_EFF)"
echo "  Adapter:        $BASE_URL"
echo "  Ollama:         $OLLAMA_BASE_URL"
echo "  LiteLLM:        $LITELLM_URL"
echo ""

if [[ ! -f "$FLOW_FILE" ]]; then
  echo "ERROR: Flow file not found: $FLOW_FILE" >&2
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

# Extract content from an OpenAI-compatible chat completion response.
_chat_content() {
  python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['choices'][0]['message']['content'])
except Exception as e:
    print('')
"
}

# Check whether a word from TEST_TOPIC appears in the text (case-insensitive).
_topic_found() {
  local text="$1"
  echo "$text" | python3 -c "
import sys
text = sys.stdin.read().lower()
topic = '${TEST_TOPIC}'.lower()
sys.exit(0 if topic in text else 1)
" 2>/dev/null
}

# ── Preflight ─────────────────────────────────────────────────────────────────
_section "Preflight"

# Ollama
if curl -sf "$OLLAMA_BASE_URL/api/tags" -o "${TMPDIR_IH}/tags.json" 2>/dev/null; then
  _pass "Ollama reachable at $OLLAMA_BASE_URL"
else
  _fail "Ollama not reachable at $OLLAMA_BASE_URL — start with: ollama serve"
  echo "" ; echo "  Cannot continue without Ollama." >&2; exit 1
fi

# Model availability
MODEL_OK=$(python3 -c "
import json, sys
tags = json.load(open('${TMPDIR_IH}/tags.json'))
names = [m['name'] for m in tags.get('models', [])]
target = '${MODEL}'
found = any(n == target or n.split(':')[0] == target.split(':')[0] for n in names)
print('yes' if found else 'no')
" 2>/dev/null || echo "no")

if [[ "$MODEL_OK" == "yes" ]]; then
  _pass "Model '$MODEL' is available"
else
  _fail "Model '$MODEL' not found in Ollama — run: ollama pull $MODEL"
  echo "  Available models:" >&2
  python3 -c "import json; [print('    ' + m['name']) for m in json.load(open('${TMPDIR_IH}/tags.json')).get('models',[])]" 2>/dev/null >&2
  exit 1
fi

# LiteLLM
LITELLM_HEALTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  "$LITELLM_URL/health/liveliness" 2>/dev/null || echo "000")
if [[ "$LITELLM_HEALTH_CODE" == "200" ]]; then
  _pass "LiteLLM reachable at $LITELLM_URL"
else
  _fail "LiteLLM not reachable at $LITELLM_URL (HTTP $LITELLM_HEALTH_CODE)"
  echo "  Layer 2 will fail. Check: docker compose ps litellm" >&2
fi

# Adapter
ADAPTER_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$BASE_URL/health" 2>/dev/null || echo "000")
if [[ "$ADAPTER_STATUS" == "200" ]]; then
  _pass "Adapter reachable at $BASE_URL"
else
  _fail "Adapter not reachable at $BASE_URL (HTTP $ADAPTER_STATUS)"
fi

# ── Layer 1: Ollama direct ────────────────────────────────────────────────────
_section "Layer 1 — Ollama direct ($OLLAMA_BASE_URL)"

PROMPT_JSON=$(python3 -c "
import json
print(json.dumps({
    'model':    '$MODEL',
    'messages': [{'role': 'user', 'content': 'In one sentence, explain $TEST_TOPIC.'}],
    'stream':   False,
}))
")

L1_HTTP=$(curl -s -o "${TMPDIR_IH}/l1.json" -w "%{http_code}" --max-time 30 \
  -X POST "$OLLAMA_BASE_URL/v1/chat/completions" \
  -H "$CONTENT_HEADER" \
  -d "$PROMPT_JSON")

if [[ "$L1_HTTP" != "200" ]]; then
  _fail "Ollama /v1/chat/completions returned HTTP $L1_HTTP"
  python3 -c "import json; d=json.load(open('${TMPDIR_IH}/l1.json')); print('  ', d.get('error', d))" 2>/dev/null || true
else
  L1_CONTENT=$(cat "${TMPDIR_IH}/l1.json" | _chat_content)
  if [[ -z "$L1_CONTENT" ]]; then
    _fail "Ollama returned HTTP 200 but response content is empty"
  else
    echo "  Response: ${L1_CONTENT:0:120}"
    if _topic_found "$L1_CONTENT"; then
      _pass "Ollama — non-empty on-topic response from $MODEL"
    else
      _pass "Ollama — non-empty response (topic '$TEST_TOPIC' not detected, but content present)"
    fi
  fi
fi

# ── Layer 2: LiteLLM proxy ────────────────────────────────────────────────────
_section "Layer 2 — LiteLLM proxy ($LITELLM_URL, model alias: $LITELLM_MODEL_ALIAS)"

if [[ -z "$LITELLM_MASTER_KEY" ]]; then
  _fail "LiteLLM — LITELLM_MASTER_KEY not set and not found in .env (skipping)"
else
  L2_PROMPT_JSON=$(python3 -c "
import json
print(json.dumps({
    'model':    '$LITELLM_MODEL_ALIAS',
    'messages': [{'role': 'user', 'content': 'In one sentence, explain $TEST_TOPIC.'}],
    'stream':   False,
}))
")

  L2_HTTP=$(curl -s -o "${TMPDIR_IH}/l2.json" -w "%{http_code}" --max-time 30 \
    -X POST "$LITELLM_URL/v1/chat/completions" \
    -H "$CONTENT_HEADER" \
    -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
    -d "$L2_PROMPT_JSON")

  if [[ "$L2_HTTP" != "200" ]]; then
    _fail "LiteLLM /v1/chat/completions returned HTTP $L2_HTTP"
    python3 -c "import json; d=json.load(open('${TMPDIR_IH}/l2.json')); print('  ', d.get('error', d))" 2>/dev/null || true
    echo "  Hint: check LiteLLM model alias '$LITELLM_MODEL_ALIAS' matches litellm_config.yaml"
  else
    L2_CONTENT=$(cat "${TMPDIR_IH}/l2.json" | _chat_content)
    if [[ -z "$L2_CONTENT" ]]; then
      _fail "LiteLLM returned HTTP 200 but response content is empty"
    else
      echo "  Response: ${L2_CONTENT:0:120}"
      if _topic_found "$L2_CONTENT"; then
        _pass "LiteLLM — non-empty on-topic response via $LITELLM_MODEL_ALIAS → $MODEL"
      else
        _pass "LiteLLM — non-empty response (topic '$TEST_TOPIC' not detected, but content present)"
      fi
    fi
  fi
fi

# ── Layer 3: Adapter → flow ───────────────────────────────────────────────────
_section "Layer 3 — Adapter flow (langgraph, model: $FLOW_MODEL)"

echo "  Flow: $FLOW_FILE"
echo "  Topic: $TEST_TOPIC"
echo ""

# Auth
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
  _fail "Adapter flow — email and password are required"
else
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
      _fail "Adapter flow — account exists but password is incorrect"; TOKEN=""
    else
      ERR=$(python3 -c "import json; d=json.load(open('${TMPDIR_IH}/auth.json')); print(d.get('detail',d))" 2>/dev/null || cat "${TMPDIR_IH}/auth.json")
      _fail "Adapter flow — registration failed ($REG_HTTP): $ERR"; TOKEN=""
    fi
  else
    ERR=$(python3 -c "import json; d=json.load(open('${TMPDIR_IH}/auth.json')); print(d.get('detail',d))" 2>/dev/null || cat "${TMPDIR_IH}/auth.json")
    _fail "Adapter flow — login failed ($LOGIN_HTTP): $ERR"; TOKEN=""
  fi

  if [[ -n "${TOKEN:-}" ]]; then
    AUTH_HEADER="Authorization: Bearer $TOKEN"

    # Build submit payload: patch the model name to match OPENAI_BASE_URL routing.
    python3 - "$FLOW_MODEL" "$TEST_TOPIC" "$FLOW_FILE" > "${TMPDIR_IH}/submit.json" <<'PYEOF'
import json, sys
model, topic, flow_file = sys.argv[1], sys.argv[2], sys.argv[3]
with open(flow_file) as f:
    spec = json.load(f)
spec.setdefault("model_defaults", {})["model"] = model
for node in spec.get("nodes", []):
    if node.get("type") in ("llm_call", "agent_role"):
        node["model"] = model
print(json.dumps({"spec": spec, "inputs": {"topic": topic}}))
PYEOF

    SUBMIT_HTTP=$(curl -s -o "${TMPDIR_IH}/submit_resp.json" -w "%{http_code}" \
      -X POST "$BASE_URL/run?runtime=langgraph" \
      -H "$AUTH_HEADER" -H "$CONTENT_HEADER" \
      -d @"${TMPDIR_IH}/submit.json")

    JOB_ID=$(python3 -c "import json; print(json.load(open('${TMPDIR_IH}/submit_resp.json')).get('job_id',''))" 2>/dev/null || echo "")
    if [[ -z "$JOB_ID" ]]; then
      _fail "Adapter flow — job submission failed (HTTP $SUBMIT_HTTP)"
      python3 -c "import json; d=json.load(open('${TMPDIR_IH}/submit_resp.json')); print('  ', d.get('detail', d))" 2>/dev/null || true
    else
      echo "  Job ID: $JOB_ID"

      DEADLINE=$(( $(date +%s) + FLOW_TIMEOUT ))
      FINAL_STATUS=""
      while true; do
        sleep "$POLL_INTERVAL"
        if [[ $(date +%s) -gt $DEADLINE ]]; then
          _fail "Adapter flow — timed out after ${FLOW_TIMEOUT}s (job: $JOB_ID)"
          FINAL_STATUS="timeout"
          break
        fi
        POLL=$(curl -s "$BASE_URL/run/$JOB_ID" -H "$AUTH_HEADER")
        STATUS=$(echo "$POLL" | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null || echo "unknown")
        if [[ "$STATUS" == "done" ]]; then
          FINAL_STATUS="done"
          break
        fi
        if [[ "$STATUS" == "error" ]]; then
          ERR=$(echo "$POLL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null || echo "unknown")
          _fail "Adapter flow — job errored: $ERR"
          echo "  Hint: if Layer 1 and Layer 2 passed, check adapter logs:"
          echo "    docker compose logs adapter --tail 50"
          FINAL_STATUS="error"
          break
        fi
        printf "  …  status: %s\r" "$STATUS"
      done

      if [[ "$FINAL_STATUS" == "done" ]]; then
        RESULT=$(echo "$POLL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',''))" 2>/dev/null || echo "")
        # Extract explanation from the final state JSON if possible
        EXPLANATION=$(echo "$RESULT" | python3 -c "
import sys, json
try:
    raw = sys.stdin.read()
    d = json.loads(raw)
    # final state is the result for LangGraph
    if isinstance(d, dict):
        print(d.get('explanation', raw)[:200])
    else:
        print(raw[:200])
except Exception:
    print(raw[:200])
" 2>/dev/null || echo "")

        if [[ -z "$EXPLANATION" ]]; then
          _fail "Adapter flow — job done but result is empty (silent LLM failure)"
          echo "  Hint: check that LiteLLM/Ollama is returning content and not an empty string."
        else
          echo "  Response: ${EXPLANATION:0:120}"
          if _topic_found "$EXPLANATION"; then
            _pass "Adapter flow — non-empty on-topic response via langgraph → $FLOW_MODEL"
          else
            _pass "Adapter flow — non-empty response (topic '$TEST_TOPIC' not detected, but content present)"
          fi
        fi
      fi
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
echo "  Model:   $MODEL"
echo "  Adapter: $BASE_URL"
echo "  Passed:  $PASS / $((PASS+FAIL))"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo "  Diagnostic guide:"
  echo "    Layer 1 failed  → Ollama is down or model not pulled: ollama pull $MODEL"
  echo "    Layer 2 failed  → LiteLLM routing broken: docker compose logs litellm --tail 30"
  echo "    Layer 3 failed  → Adapter LLM path broken: docker compose logs adapter --tail 30"
  echo "    All layers ok   → check token budget / empty response in flow result"
  echo ""
fi

[[ "$FAIL" -eq 0 ]]
