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
           "sk-ant-REPLACE" "sk-REPLACE" \
           "sk-ant-..." "sk-..." "..."; do
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

# MASTRA_RUNNER_API_KEY — optional (empty = no auth, dev only); warn if unset
MASTRA_KEY=$(get_val "MASTRA_RUNNER_API_KEY")
if [[ -z "$MASTRA_KEY" ]]; then
  warn "MASTRA_RUNNER_API_KEY is empty — mastra-runner has no auth (dev-only mode)"
  echo "         Fix: run ./setup-env.sh to auto-generate it"
  echo ""
else
  ok "MASTRA_RUNNER_API_KEY"
fi

# ── Special check: DATABASE_URL must have real password and correct host ────────
DB_URL=$(get_val "DATABASE_URL")
PG_PASS=$(get_val "POSTGRES_PASSWORD")
if ! is_placeholder "$DB_URL"; then
  # Check for placeholder password in URL
  if echo "$DB_URL" | grep -qE "REPLACE_WITH_REAL|REPLACE_ME|changeme|placeholder"; then
    fail "DATABASE_URL — still contains a placeholder password"
    echo "         Fix: run ./setup-env.sh to rebuild it from POSTGRES_PASSWORD"
    echo ""
    ALL_OK=1
  else
    # Check password in URL matches POSTGRES_PASSWORD
    url_pass=$(echo "$DB_URL" | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')
    if [[ -n "$PG_PASS" && "$url_pass" != "$PG_PASS" ]]; then
      fail "DATABASE_URL — password does not match POSTGRES_PASSWORD"
      echo "         Fix: run ./setup-env.sh to sync it automatically"
      echo ""
      ALL_OK=1
    # Warn if using localhost instead of Docker service name
    elif echo "$DB_URL" | grep -q "@localhost:"; then
      warn "DATABASE_URL uses 'localhost' — should be '@postgres:5432' inside Docker Compose"
      echo "         Fix: run ./setup-env.sh to correct it"
      echo ""
      ALL_OK=1
    else
      ok "DATABASE_URL"
    fi
  fi
fi

# ── Special check: REDIS_URL must be concrete (no unexpanded shell vars) ──────
REDIS_URL_VAL=$(get_val "REDIS_URL")
REDIS_PASS=$(get_val "REDIS_PASSWORD")
if [[ -n "$REDIS_URL_VAL" ]]; then
  if echo "$REDIS_URL_VAL" | grep -qE '\$\{|\$REDIS'; then
    fail "REDIS_URL — contains unexpanded shell variable — run ./setup-env.sh to concrete it"
    echo ""
    ALL_OK=1
  else
    redis_url_pass=$(echo "$REDIS_URL_VAL" | sed -E 's|.*://:([^@]+)@.*|\1|')
    if [[ -n "$REDIS_PASS" && "$redis_url_pass" != "$REDIS_PASS" ]]; then
      fail "REDIS_URL — password does not match REDIS_PASSWORD"
      echo "         Fix: run ./setup-env.sh to sync it automatically"
      echo ""
      ALL_OK=1
    else
      ok "REDIS_URL"
    fi
  fi
fi

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

# EXTRA_CALLABLE_MODULES — required for flows that call custom Python modules
# via the Mastra fn_ref bridge. Empty = only built-in modules (rag_utils) are callable.
EXTRA_MODS=$(get_val "EXTRA_CALLABLE_MODULES")
if [[ -z "$EXTRA_MODS" ]]; then
  warn "EXTRA_CALLABLE_MODULES is not set."
  echo "         Flows that invoke custom Python modules via fn_ref nodes will fail"
  echo "         at runtime. Set this to a comma-separated list of module names in"
  echo "         .env if your flows require it (e.g. EXTRA_CALLABLE_MODULES=my_tools)."
else
  ok "EXTRA_CALLABLE_MODULES = ${EXTRA_MODS}"
fi

# ── .env.local cross-check — VITE_LANGFUSE_PUBLIC_KEY must match .env ──────────
echo ""
echo "Checking .env.local sync …"
echo ""

if [[ ! -f .env.local ]]; then
  warn ".env.local not found — run ./setup-env.sh to create it"
  ALL_OK=1
else
  # VITE_LANGFUSE_PUBLIC_KEY must match LANGFUSE_PUBLIC_KEY in .env
  lf_env=$(grep -E "^LANGFUSE_PUBLIC_KEY=" .env 2>/dev/null | cut -d= -f2-)
  lf_vite=$(grep -E "^VITE_LANGFUSE_PUBLIC_KEY=" .env.local 2>/dev/null | cut -d= -f2-)
  if [[ -n "$lf_env" && "$lf_env" != "$lf_vite" ]]; then
    fail "VITE_LANGFUSE_PUBLIC_KEY in .env.local does not match LANGFUSE_PUBLIC_KEY in .env"
    echo "         .env           = ${lf_env:0:16}…"
    echo "         .env.local     = ${lf_vite:0:16}…"
    echo "         Traces will be rejected by Langfuse — fix: run ./setup-env.sh"
    echo ""
    ALL_OK=1
  else
    ok "VITE_LANGFUSE_PUBLIC_KEY matches LANGFUSE_PUBLIC_KEY"
  fi

  # Required static VITE keys must be present
  for vite_key in VITE_API_URL VITE_LANGFUSE_ENABLED VITE_LANGFUSE_HOST; do
    if ! grep -qE "^${vite_key}=" .env.local 2>/dev/null; then
      fail "${vite_key} missing from .env.local — run ./setup-env.sh to repair"
      echo ""
      ALL_OK=1
    else
      ok "${vite_key} present in .env.local"
    fi
  done
fi

# ── .env.bak cross-check ─────────────────────────────────────────────────────
echo ""
echo "Checking .env.bak sync …"
echo ""

CRITICAL_KEYS=(JWT_SECRET POSTGRES_PASSWORD REDIS_PASSWORD DATABASE_URL REDIS_URL
               LITELLM_MASTER_KEY MASTRA_RUNNER_API_KEY
               LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_ADMIN_EMAIL
               LANGFUSE_ADMIN_PASSWORD LANGFUSE_NEXTAUTH_SECRET LANGFUSE_SALT
               LANGFUSE_ENCRYPTION_KEY CLICKHOUSE_PASSWORD OPENAI_API_KEY ANTHROPIC_API_KEY)

if [[ ! -f .env.bak ]]; then
  warn ".env.bak not found — run ./setup-env.sh to create it"
  ALL_OK=1
else
  BAK_DRIFT=0
  for key in "${CRITICAL_KEYS[@]}"; do
    v_env=$(grep -E "^${key}=" .env     2>/dev/null | tail -1 | cut -d= -f2-)
    v_bak=$(grep -E "^${key}=" .env.bak 2>/dev/null | tail -1 | cut -d= -f2-)
    if [[ -z "$v_env" ]]; then
      continue  # already caught above
    fi
    if [[ "$v_env" != "$v_bak" ]]; then
      fail "$key — MISMATCH between .env and .env.bak"
      echo "         .env     = ${v_env:0:8}… (${#v_env} chars)"
      echo "         .env.bak = ${v_bak:0:8}… (${#v_bak} chars)"
      echo "         Fix: run ./setup-env.sh — it will sync .env.bak automatically"
      echo ""
      BAK_DRIFT=1
      ALL_OK=1
    fi
  done
  if [[ $BAK_DRIFT -eq 0 ]]; then
    ok ".env.bak is in sync with .env for all critical secrets"
  fi
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
