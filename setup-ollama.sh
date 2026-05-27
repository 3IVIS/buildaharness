#!/usr/bin/env bash
# setup-ollama.sh — Test all 4 itsharness adapters against a local Ollama server.
#
# Submits flows/06-ollama-simple-flow.json to every runtime, polls for
# completion, and verifies the response mentions the expected topic.
#
# ── Usage ─────────────────────────────────────────────────────────────────────
#   ./setup-ollama.sh                         # mistral:latest, all 4 runtimes
#   ./setup-ollama.sh qwen3:latest            # different model
#   ./setup-ollama.sh mistral:latest physics  # custom test topic
#   RUNTIME=langgraph ./setup-ollama.sh       # single runtime
#
# ── Non-interactive / CI mode ─────────────────────────────────────────────────
#   TEST_EMAIL=ci@example.com \
#   TEST_PASSWORD=CiPass99! \
#   ./setup-ollama.sh
#
#   If TEST_EMAIL/TEST_PASSWORD are set the script skips the interactive prompt
#   and auto-registers the account on first run.
#
# ── Prerequisites ─────────────────────────────────────────────────────────────
#   1. Ollama running  : ollama serve  (or the macOS menu-bar app)
#   2. Model pulled    : ollama pull mistral:latest
#   3. Stack running   : docker compose up  (or adapter running locally)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
MODEL="${1:-mistral:latest}"
TOPIC="${2:-photosynthesis}"
BASE_URL="${BASE_URL:-http://localhost:8000}"
RUNTIME="${RUNTIME:-all}"      # langgraph | crewai | microsoft_agent_framework | mastra | all
TIMEOUT="${TIMEOUT:-150}"      # seconds to wait per job
FLOW_FILE="flows/06-ollama-simple-flow.json"
CONTENT_HEADER="Content-Type: application/json"
TMPDIR_IH=$(mktemp -d)
trap 'rm -rf "$TMPDIR_IH"' EXIT

# ── Colour helpers ────────────────────────────────────────────────────────────
info()   { printf "  \033[36m➜\033[0m  %s\n" "$*"; }
ok()     { printf "  \033[32m✓\033[0m  %s\n" "$*"; }
warn()   { printf "  \033[33m⚠\033[0m  %s\n" "$*"; }
fail()   { printf "  \033[31m✗\033[0m  %s\n" "$*" >&2; }
header() { printf "\n\033[1m━━  %s  ━━\033[0m\n" "$*"; }

# ── Helper: extract a readable snippet from a job-status JSON string ──────────
extract_result() {
  python3 - "$1" << 'PYEOF'
import json, sys
raw = sys.argv[1]
try:
    d = json.loads(raw)
except Exception:
    print("(parse error)")
    sys.exit(0)
r_raw = d.get("result") or ""
try:
    r = json.loads(r_raw) if isinstance(r_raw, str) else r_raw
except Exception:
    r = r_raw
def dig(r):
    if isinstance(r, str):
        return r
    if isinstance(r, dict):
        return (r.get("explanation")
                or r.get("output")
                or (r.get("result") and dig(r["result"]))
                or ((r.get("steps") or {}).get("explain") and
                    dig((r["steps"]["explain"].get("output") or {})))
                or json.dumps(r)[:300])
    return str(r)[:300]
print(dig(r))
PYEOF
}

# ── Helper: check topic appears in text ───────────────────────────────────────
topic_found() {
  # Returns 0 (success) if any word from the first two words of TOPIC
  # (longer than 3 chars) appears in the result text.
  echo "$1" | python3 -c "
import sys, re
text = sys.stdin.read().lower()
topic_words = '${TOPIC}'.lower().split()[:2]
found = any(w in text for w in topic_words if len(w) > 3)
sys.exit(0 if found else 2)
" 2>/dev/null
}

# ── 1. Preflight checks ───────────────────────────────────────────────────────
header "Preflight"

if ! curl -sf "${OLLAMA_BASE_URL}/api/tags" >/dev/null 2>&1; then
  fail "Ollama is not running at ${OLLAMA_BASE_URL}"
  echo ""; echo "    Start it:    ollama serve"; echo "    macOS app:   open -a Ollama"
  exit 1
fi
ok "Ollama is running at ${OLLAMA_BASE_URL}"

if ! curl -sf "${OLLAMA_BASE_URL}/api/tags" | python3 -c "
import sys, json
tags = json.load(sys.stdin)
names = [m['name'] for m in tags.get('models', [])]
target = '${MODEL}'
found = any(n == target or n.split(':')[0] == target.split(':')[0] for n in names)
sys.exit(0 if found else 1)
" 2>/dev/null; then
  info "Model '${MODEL}' not found — pulling (may take a few minutes)…"
  ollama pull "${MODEL}"
fi
ok "Model '${MODEL}' is available"

if ! curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
  fail "itsharness adapter is not running at ${BASE_URL}"
  echo ""
  echo "  Option A — Docker Compose:"; echo "    docker compose up"
  echo "  Option B — local dev:"
  echo "    export OPENAI_BASE_URL=${OLLAMA_BASE_URL}/v1"
  echo "    export OPENAI_API_KEY=ollama"
  echo "    cd adapter && uvicorn main:app --host 0.0.0.0 --port 8000 --reload"
  exit 1
fi
ADAPTER_VER=$(curl -sf "${BASE_URL}/health" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null || echo "?")
ok "Adapter v${ADAPTER_VER} is running at ${BASE_URL}"

# ── 2. Authentication ─────────────────────────────────────────────────────────
header "Authentication"

if [[ -n "${TEST_EMAIL:-}" && -n "${TEST_PASSWORD:-}" ]]; then
  EMAIL="$TEST_EMAIL"
  PASSWORD="$TEST_PASSWORD"
  info "Using TEST_EMAIL / TEST_PASSWORD from environment"
else
  printf "  Email:    "; read -r EMAIL
  printf "  Password: "; read -rs PASSWORD; echo ""
fi

[[ -z "$EMAIL" || -z "$PASSWORD" ]] && { fail "Email and password are required."; exit 1; }

CREDS=$(python3 -c "
import json, sys
print(json.dumps({'email': sys.argv[1], 'password': sys.argv[2]}))" "$EMAIL" "$PASSWORD")

LOGIN_HTTP=$(curl -s -o "${TMPDIR_IH}/auth.json" -w "%{http_code}" \
  -X POST "${BASE_URL}/auth/login" -H "$CONTENT_HEADER" -d "$CREDS")

if [[ "$LOGIN_HTTP" == "200" ]]; then
  TOKEN=$(python3 -c "import json; print(json.load(open('${TMPDIR_IH}/auth.json'))['token'])")
  ok "Logged in as ${EMAIL}"
elif [[ "$LOGIN_HTTP" == "401" ]]; then
  info "Account not found — registering…"
  REG_HTTP=$(curl -s -o "${TMPDIR_IH}/reg.json" -w "%{http_code}" \
    -X POST "${BASE_URL}/auth/register" -H "$CONTENT_HEADER" -d "$CREDS")
  if [[ "$REG_HTTP" != "200" && "$REG_HTTP" != "201" ]]; then
    fail "Registration failed (HTTP ${REG_HTTP})"
    cat "${TMPDIR_IH}/reg.json" >&2; exit 1
  fi
  TOKEN=$(python3 -c "import json; print(json.load(open('${TMPDIR_IH}/reg.json'))['token'])")
  ok "Registered and logged in as ${EMAIL}"
else
  fail "Auth failed (HTTP ${LOGIN_HTTP})"
  cat "${TMPDIR_IH}/auth.json" >&2; exit 1
fi

AUTH_HEADER="Authorization: Bearer ${TOKEN}"

# ── 3. Build payload ──────────────────────────────────────────────────────────
# Patch the flow spec to use the requested model; wrap in the run body.
# 'inputs' seeds the flow's initial state — required so the adapter forwards
# the topic value to all runtimes (without it the state defaults to schema zeros).
PAYLOAD=$(python3 - "$MODEL" "$TOPIC" "$FLOW_FILE" << 'PYEOF'
import json, sys
model, topic, flow_file = sys.argv[1], sys.argv[2], sys.argv[3]
with open(flow_file) as f:
    spec = json.load(f)
spec["model_defaults"]["model"] = model
for node in spec.get("nodes", []):
    if node.get("type") == "llm_call":
        node["model"] = model
print(json.dumps({"spec": spec, "inputs": {"topic": topic}}))
PYEOF
)

# ── 4. Submit jobs ────────────────────────────────────────────────────────────
header "Submitting jobs"
info "Flow  : ${FLOW_FILE}"
info "Model : ${MODEL}"
info "Topic : ${TOPIC}"
echo ""

if [[ "$RUNTIME" == "all" ]]; then
  RUNTIMES="langgraph crewai microsoft_agent_framework mastra"
else
  RUNTIMES="$RUNTIME"
fi

# Store job IDs and start times as flat files under TMPDIR_IH
for rt in $RUNTIMES; do
  SUBMIT_HTTP=$(curl -s -o "${TMPDIR_IH}/submit_${rt}.json" -w "%{http_code}" \
    -X POST "${BASE_URL}/run?runtime=${rt}" \
    -H "$CONTENT_HEADER" -H "$AUTH_HEADER" \
    --data-raw "$PAYLOAD")

  if [[ "$SUBMIT_HTTP" != "200" && "$SUBMIT_HTTP" != "201" && "$SUBMIT_HTTP" != "202" ]]; then
    fail "$(printf '%-30s' "${rt}") submit failed (HTTP ${SUBMIT_HTTP})"
    cat "${TMPDIR_IH}/submit_${rt}.json" >&2
    echo "skipped" > "${TMPDIR_IH}/verdict_${rt}"
    continue
  fi

  JOB_ID=$(python3 -c "
import json; print(json.load(open('${TMPDIR_IH}/submit_${rt}.json'))['job_id'])")
  echo "$JOB_ID"      > "${TMPDIR_IH}/jobid_${rt}"
  date +%s            > "${TMPDIR_IH}/start_${rt}"
  ok "$(printf '%-30s' "${rt}") → ${JOB_ID}"
done

echo ""

# ── 5. Poll until all jobs finish ─────────────────────────────────────────────
header "Waiting for results"

# Build list of runtimes that have a job file (submit succeeded)
PENDING=""
for rt in $RUNTIMES; do
  if [[ -f "${TMPDIR_IH}/jobid_${rt}" ]]; then
    PENDING="${PENDING} ${rt}"
  fi
done
PENDING="${PENDING# }"   # trim leading space

while [[ -n "$PENDING" ]]; do
  sleep 3
  NEXT_PENDING=""
  for rt in $PENDING; do
    JID=$(cat "${TMPDIR_IH}/jobid_${rt}")
    START=$(cat "${TMPDIR_IH}/start_${rt}")
    ELAPSED=$(( $(date +%s) - START ))

    STATUS_JSON=$(curl -sf "${BASE_URL}/run/${JID}" -H "$AUTH_HEADER" 2>/dev/null \
      || echo '{"status":"error","error":"poll failed"}')
    STATUS=$(python3 -c "
import json,sys; print(json.loads(sys.argv[1]).get('status','?'))" "$STATUS_JSON")

    if [[ "$STATUS" == "done" ]]; then
      SNIPPET=$(extract_result "$STATUS_JSON")
      if topic_found "$SNIPPET"; then
        ok "$(printf '%-30s' "${rt}") done in ${ELAPSED}s — topic verified ✓"
        echo "pass" > "${TMPDIR_IH}/verdict_${rt}"
      else
        warn "$(printf '%-30s' "${rt}") done in ${ELAPSED}s — topic not in response"
        echo "warn" > "${TMPDIR_IH}/verdict_${rt}"
      fi
      printf "  \033[90m%s\033[0m\n" "${SNIPPET:0:120}"

    elif [[ "$STATUS" == "error" ]]; then
      ERR=$(python3 -c "
import json,sys; print(json.loads(sys.argv[1]).get('error','unknown'))" "$STATUS_JSON")
      fail "$(printf '%-30s' "${rt}") errored after ${ELAPSED}s: ${ERR}"
      echo "fail" > "${TMPDIR_IH}/verdict_${rt}"

    elif [[ "$ELAPSED" -ge "$TIMEOUT" ]]; then
      fail "$(printf '%-30s' "${rt}") timed out after ${TIMEOUT}s (last status: ${STATUS})"
      echo "timeout" > "${TMPDIR_IH}/verdict_${rt}"

    else
      printf "  \033[2m⏳  %-30s %s (%ds)…\033[0m\r" "${rt}" "${STATUS}" "${ELAPSED}"
      NEXT_PENDING="${NEXT_PENDING} ${rt}"
    fi
  done
  PENDING="${NEXT_PENDING# }"
done

# ── 6. Summary ────────────────────────────────────────────────────────────────
header "Summary"

PASSED=0; WARNED=0; FAILED=0

for rt in $RUNTIMES; do
  VERDICT=$(cat "${TMPDIR_IH}/verdict_${rt}" 2>/dev/null || echo "skipped")
  case "$VERDICT" in
    pass)    ok   "$(printf '%-30s' "${rt}") PASS";   PASSED=$((PASSED+1)) ;;
    warn)    warn "$(printf '%-30s' "${rt}") PASS (topic check weak)"; WARNED=$((WARNED+1)) ;;
    fail)    fail "$(printf '%-30s' "${rt}") FAIL";   FAILED=$((FAILED+1)) ;;
    timeout) fail "$(printf '%-30s' "${rt}") TIMEOUT"; FAILED=$((FAILED+1)) ;;
    skipped) warn "$(printf '%-30s' "${rt}") SKIPPED (submit error)" ;;
  esac
done

TOTAL=$((PASSED+WARNED+FAILED))
echo ""
echo "  Model  : ${MODEL}"
echo "  Topic  : ${TOPIC}"
echo "  Adapter: ${BASE_URL}"
echo ""

if [[ $FAILED -eq 0 ]]; then
  ok "All ${TOTAL} runtime(s) passed"
  echo ""
  [[ $WARNED -gt 0 ]] && warn "${WARNED} had a weak topic check — review snippets above"
  echo "  To test a single runtime:"
  echo "    RUNTIME=langgraph ./setup-ollama.sh ${MODEL}"
  echo ""
  exit 0
else
  fail "${FAILED} of ${TOTAL} runtime(s) failed"
  echo ""
  echo "  Common causes:"
  echo "    • OPENAI_BASE_URL not pointing to Ollama in your .env (or adapter env)"
  echo "    • Model name mismatch — run: ollama list"
  echo "    • Adapter logs: docker compose logs adapter --tail 50"
  echo ""
  exit 1
fi
