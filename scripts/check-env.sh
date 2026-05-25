#!/usr/bin/env bash
# check-env.sh — verify all required secrets are set in .env.
#
# Usage:
#   bash scripts/check-env.sh
#
# Exits 0 if all checks pass, 1 if any fail.

set -uo pipefail

GREEN="\033[32m"; RED="\033[31m"; YELLOW="\033[33m"; RESET="\033[0m"

ok()   { echo -e "  ${GREEN}✓${RESET}  $*"; }
fail() { echo -e "  ${RED}✗${RESET}  $*"; }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $*"; }

# Read a key's value from .env (last occurrence wins, matching Docker Compose).
get_val() {
  grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2-
}

# Returns 0 (true) if the value is blank or looks like a placeholder.
is_placeholder() {
  local val="$1"
  [[ -z "$val" ]] && return 0
  for p in "REPLACE_ME" "REPLACE_WITH_REAL" "your_password" \
           "changeme" "placeholder" "YOUR_" \
           "sk-ant-REPLACE" "sk-REPLACE"; do
    [[ "$val" == *"$p"* ]] && return 0
  done
  return 1
}

if [[ ! -f .env ]]; then
  echo -e "${RED}✗${RESET}  .env not found."
  echo "   Run ./setup-env.sh (or: cp .env.example .env and fill in values)"
  exit 1
fi

echo ""
echo "Checking .env …"
echo ""

ALL_OK=0   # 0 = all good so far; flip to 1 on first failure

# ── Required auto-generated secrets ───────────────────────────────────────────
check_secret() {
  local key="$1" hint="$2"
  local val
  val=$(get_val "$key")
  if is_placeholder "$val"; then
    fail "$key — not set or still a placeholder"
    echo "         Hint: $hint"
    echo "         Fix:  run ./setup-env.sh to repair automatically"
    echo ""
    ALL_OK=1
  else
    ok "$key"
  fi
}

check_secret JWT_SECRET               "openssl rand -base64 32"
check_secret POSTGRES_PASSWORD        "openssl rand -base64 24 | tr -d '=+/'"
check_secret REDIS_PASSWORD           "openssl rand -base64 24 | tr -d '=+/'"
check_secret LITELLM_MASTER_KEY       "openssl rand -base64 32"
check_secret LANGFUSE_ADMIN_EMAIL     "(your email address)"
check_secret LANGFUSE_ADMIN_PASSWORD  "(your chosen password)"
check_secret LANGFUSE_NEXTAUTH_SECRET "openssl rand -base64 32"
check_secret LANGFUSE_SALT            "openssl rand -base64 32"
check_secret LANGFUSE_ENCRYPTION_KEY  "openssl rand -hex 32  ← must be exactly 64 hex chars"
check_secret CLICKHOUSE_PASSWORD      "openssl rand -hex 24"

# ── Special check: LANGFUSE_ENCRYPTION_KEY must be exactly 64 hex chars ───────
ENC=$(get_val "LANGFUSE_ENCRYPTION_KEY")
if ! is_placeholder "$ENC"; then
  LEN=${#ENC}
  if [[ $LEN -ne 64 ]]; then
    fail "LANGFUSE_ENCRYPTION_KEY is $LEN chars — must be exactly 64 (openssl rand -hex 32)"
    ALL_OK=1
  elif ! [[ "$ENC" =~ ^[0-9a-fA-F]{64}$ ]]; then
    fail "LANGFUSE_ENCRYPTION_KEY is not valid hex — regenerate with: openssl rand -hex 32"
    ALL_OK=1
  else
    ok "LANGFUSE_ENCRYPTION_KEY (64 hex chars ✓)"
  fi
fi

# ── Optional but worth flagging ────────────────────────────────────────────────
echo ""
OPENAI=$(get_val "OPENAI_API_KEY")
ANTHROPIC=$(get_val "ANTHROPIC_API_KEY")
if is_placeholder "$OPENAI" && is_placeholder "$ANTHROPIC"; then
  warn "No LLM API keys set (OPENAI_API_KEY / ANTHROPIC_API_KEY)."
  echo "         LLM nodes won't execute until at least one is added to .env."
else
  ok "At least one LLM API key is set"
fi

# ── Result ─────────────────────────────────────────────────────────────────────
echo ""
if [[ $ALL_OK -eq 0 ]]; then
  echo -e "${GREEN}✓  All required secrets are set. Ready for: docker compose up${RESET}"
else
  echo -e "${RED}✗  Fix the issues above, then re-run: bash scripts/check-env.sh${RESET}"
  echo    "   Or run ./setup-env.sh to repair everything automatically."
fi
echo ""

exit $ALL_OK
