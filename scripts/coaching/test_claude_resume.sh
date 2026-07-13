#!/usr/bin/env bash
# test_claude_resume.sh — verifies two things before the coaching loop implementation:
#   1. Session ID can be extracted from stream-json init event
#   2. `claude --resume <id> --print` preserves context from the prior session
#
# Run with: bash scripts/test_claude_resume.sh
# Expected output: PASS on both checks.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG1="$SCRIPT_DIR/../reports/test_resume_turn1.log"
LOG2="$SCRIPT_DIR/../reports/test_resume_turn2.log"
mkdir -p "$(dirname "$LOG1")"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
pass() { echo "  ✓ PASS: $*"; }
fail() { echo "  ✗ FAIL: $*"; exit 1; }

# ── helpers ───────────────────────────────────────────────────────────────────

extract_session_id() {
    # Read a stream-json log, return the session_id from the first init event.
    python3 - "$1" <<'EOF'
import sys, json
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    if e.get("type") == "system" and e.get("subtype") == "init":
        print(e.get("session_id", ""))
        break
EOF
}

extract_exit_reason() {
    # Read a stream-json log, return exit_reason from the result event.
    python3 - "$1" <<'EOF'
import sys, json
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    if e.get("type") == "result":
        if e.get("is_error") and e.get("api_error_status") == 429:
            print("rate_limited")
        elif e.get("is_error"):
            print("error")
        elif e.get("stop_reason") == "end_turn":
            print("success")
        else:
            print("unknown:" + str(e.get("stop_reason", "")))
        break
EOF
}

extract_result_text() {
    python3 - "$1" <<'EOF'
import sys, json
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    if e.get("type") == "result":
        print(e.get("result", ""))
        break
EOF
}

# ── Turn 1: ask Claude to do a small calculation with a unique number ─────────
# Using a simple math question avoids any refusal heuristics.
# The unique number (MAGIC) lets us verify it appears in both turns' context.

log "Turn 1 — sending a simple question with a unique number…"

MAGIC="7382910"
PROMPT1="What is ${MAGIC} divided by 2? Just give the number."

claude --dangerously-skip-permissions --print --verbose --output-format stream-json \
    <<< "$PROMPT1" \
    2>&1 | tee "$LOG1" | python3 "$SCRIPT_DIR/stream_pretty.py"

echo ""

# ── Check 1: session ID extraction ───────────────────────────────────────────

SESSION_ID=$(extract_session_id "$LOG1")
if [[ -z "$SESSION_ID" ]]; then
    fail "No session_id found in stream-json init event (log: $LOG1)"
fi
pass "Session ID extracted: $SESSION_ID"

EXIT_REASON=$(extract_exit_reason "$LOG1")
log "  Exit reason: $EXIT_REASON"

RESULT_TEXT=$(extract_result_text "$LOG1")
EXPECTED_ANSWER="3691455"
if echo "$RESULT_TEXT" | grep -q "$EXPECTED_ANSWER"; then
    pass "Turn 1 response contains the correct answer ($EXPECTED_ANSWER)"
else
    fail "Turn 1 response did not contain $EXPECTED_ANSWER. Got: ${RESULT_TEXT:0:200}"
fi

# ── Turn 2: resume and ask about the prior question ──────────────────────────

log "Turn 2 — resuming session $SESSION_ID and asking about the previous question…"

claude --dangerously-skip-permissions --print --verbose --output-format stream-json \
    --resume "$SESSION_ID" \
    <<< "What number did I ask you to divide by 2 in my previous message? Just give the number." \
    2>&1 | tee "$LOG2" | python3 "$SCRIPT_DIR/stream_pretty.py"

echo ""

# ── Check 2: context preserved across resume ──────────────────────────────────

RESULT2=$(extract_result_text "$LOG2")
if echo "$RESULT2" | grep -q "$MAGIC"; then
    pass "Resumed session recalled the original number ($MAGIC) — context preserved across --resume --print"
else
    fail "--resume did not preserve context. Got: ${RESULT2:0:300}"
fi

SESSION_ID2=$(extract_session_id "$LOG2")
if [[ "$SESSION_ID2" == "$SESSION_ID" ]]; then
    pass "Session ID is the same across both turns: $SESSION_ID"
else
    log "  Note: session ID changed on resume (turn1=$SESSION_ID turn2=$SESSION_ID2) — this is fine as long as context was preserved"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════"
echo "  All checks passed. Safe to implement."
echo "══════════════════════════════════════════"
echo ""
echo "  Session ID:      $SESSION_ID"
echo "  Exit reason T1:  $EXIT_REASON"
echo "  Log turn 1:      $LOG1"
echo "  Log turn 2:      $LOG2"
