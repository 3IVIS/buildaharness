#!/usr/bin/env bash
# setup-env.sh — first-time setup (and re-run safe repair) for itsharness.
#
# Usage:
#   chmod +x setup-env.sh
#   ./setup-env.sh
#
# What it does:
#   1. Generates / repairs all required secrets in .env
#      - Writes a fresh .env if none exists
#      - Replaces any placeholder values in an existing .env in-place
#      - Prompts for values that can't be auto-generated (email, API keys)
#   2. Writes .env.local for the Vite canvas dev server
#   Then asks whether to also run:
#   3. Create the Python virtual environment + install adapter dependencies
#   4. Generate the mastra-runner package-lock.json
#   5. Start the full Docker stack

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Colour helpers ─────────────────────────────────────────────────────────────
BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; CYAN="\033[36m"
RED="\033[31m"; DIM="\033[2m"; RESET="\033[0m"

info()    { echo -e "${CYAN}▸${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET}  $*"; }
error()   { echo -e "${RED}✗${RESET} $*" >&2; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }
dim()     { echo -e "${DIM}$*${RESET}"; }

ask_yes_no() {
  # ask_yes_no "Question text" [y|n]   — returns 0=yes 1=no
  local prompt="$1" default="${2:-n}"
  local yn_hint
  [[ "$default" == "y" ]] && yn_hint="[Y/n]" || yn_hint="[y/N]"
  printf "  %s %s " "$prompt" "$yn_hint"
  read -r reply
  reply="${reply:-$default}"
  [[ "$(echo "$reply" | tr "[:upper:]" "[:lower:]")" == "y" ]]
}

rand_base64() { openssl rand -base64 "$1" | tr -d '\n=/+'; }
rand_hex()    { openssl rand -hex "$1"; }

# Write or replace a key=value line in .env.
# If the key exists (even with a placeholder), replaces it in place.
# If it doesn't exist, appends it.
set_env_key() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .env 2>/dev/null; then
    # In-place replacement — works on macOS (BSD sed) and Linux (GNU sed)
    if [[ "$(uname)" == "Darwin" ]]; then
      sed -i '' "s|^${key}=.*|${key}=${value}|" .env
    else
      sed -i    "s|^${key}=.*|${key}=${value}|" .env
    fi
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}

is_placeholder() {
  # Returns 0 (true) if the value looks like a placeholder or is empty
  local val="$1"
  [[ -z "$val" ]] && return 0
  local placeholders=("REPLACE_ME" "REPLACE_WITH_REAL" "your_password"
                      "changeme" "placeholder" "YOUR_"
                      "sk-ant-REPLACE" "sk-REPLACE")
  for p in "${placeholders[@]}"; do
    [[ "$val" == *"$p"* ]] && return 0
  done
  return 1
}

get_env_val() {
  grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2-
}

# ── Preflight ──────────────────────────────────────────────────────────────────
header "itsharness — setup"

if ! command -v openssl &>/dev/null; then
  error "openssl not found. Install it and re-run."; exit 1
fi

# ── Step 1: Secrets ────────────────────────────────────────────────────────────
header "Step 1 — Secrets"

# Bootstrap .env from example if it doesn't exist yet
if [[ ! -f .env ]]; then
  if [[ -f .env.example ]]; then
    cp .env.example .env
    info "Created .env from .env.example"
  else
    touch .env
    info "Created empty .env"
  fi
fi

info "Generating / repairing secrets in .env …"
echo ""

# --- Auto-generated secrets ---------------------------------------------------
# Each one: if absent or placeholder → generate a fresh value and write it.

_fix_secret() {
  # _fix_secret KEY GENERATOR [VALIDATOR]
  # VALIDATOR is a bash expression that returns 0 if the current value is valid.
  # If absent, any non-placeholder value is accepted.
  local key="$1" generator="$2" validator="${3:-}"
  local current
  current=$(get_env_val "$key")
  local needs_fix=false
  if is_placeholder "$current"; then
    needs_fix=true
  elif [[ -n "$validator" ]] && ! eval "$validator" &>/dev/null; then
    warn "$key has an invalid value ($(echo "$current" | wc -c | tr -d ' ') chars) — regenerating"
    needs_fix=true
  fi
  if $needs_fix; then
    local val
    val=$(eval "$generator")
    set_env_key "$key" "$val"
    success "$key"
  else
    dim "  ↳ $key already set — keeping"
  fi
}

_fix_secret JWT_SECRET               'rand_base64 32'
_fix_secret POSTGRES_PASSWORD        'rand_base64 24'
_fix_secret REDIS_PASSWORD           'rand_base64 24'
_fix_secret LITELLM_MASTER_KEY       'rand_base64 32'
_fix_secret LANGFUSE_NEXTAUTH_SECRET 'rand_base64 32'
_fix_secret LANGFUSE_SALT            'rand_base64 32'
_fix_secret LANGFUSE_ENCRYPTION_KEY  'rand_hex 32' \
  '[[ ${#current} -eq 64 ]] && [[ "$current" =~ ^[0-9a-fA-F]{64}$ ]]'
_fix_secret CLICKHOUSE_PASSWORD      'rand_hex 24'

# Langfuse API key pair — generate together so they stay consistent
LFPUB=$(get_env_val "LANGFUSE_PUBLIC_KEY")
LFSEC=$(get_env_val "LANGFUSE_SECRET_KEY")
if is_placeholder "$LFPUB" || is_placeholder "$LFSEC"; then
  set_env_key LANGFUSE_PUBLIC_KEY "pk-lf-$(rand_hex 16)"
  set_env_key LANGFUSE_SECRET_KEY "sk-lf-$(rand_hex 16)"
  success "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY"
else
  dim "  ↳ LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY already set — keeping"
fi

# --- Values that require human input ------------------------------------------
echo ""
info "Values that need your input:"
echo ""

# Langfuse admin email
CURRENT_EMAIL=$(get_env_val "LANGFUSE_ADMIN_EMAIL")
if is_placeholder "$CURRENT_EMAIL"; then
  printf "  Langfuse admin email [admin@example.com]: "
  read -r inp_email
  set_env_key LANGFUSE_ADMIN_EMAIL "${inp_email:-admin@example.com}"
  success "LANGFUSE_ADMIN_EMAIL"
else
  dim "  ↳ LANGFUSE_ADMIN_EMAIL already set — keeping (${CURRENT_EMAIL})"
fi

# Langfuse admin password
CURRENT_PW=$(get_env_val "LANGFUSE_ADMIN_PASSWORD")
if is_placeholder "$CURRENT_PW"; then
  printf "  Langfuse admin password [leave blank to auto-generate]: "
  read -rs inp_pw; echo
  if [[ -z "$inp_pw" ]]; then
    inp_pw="$(rand_base64 16)"
    warn "Auto-generated Langfuse password — see .env for the value"
  fi
  set_env_key LANGFUSE_ADMIN_PASSWORD "$inp_pw"
  success "LANGFUSE_ADMIN_PASSWORD"
else
  dim "  ↳ LANGFUSE_ADMIN_PASSWORD already set — keeping"
fi

# LLM API keys (optional but useful to set now)
echo ""
info "LLM API keys (optional — press Enter to skip, add to .env later):"
echo ""

CURRENT_OPENAI=$(get_env_val "OPENAI_API_KEY")
if is_placeholder "$CURRENT_OPENAI"; then
  printf "  OpenAI API key (sk-...): "
  read -r inp_openai
  [[ -n "$inp_openai" ]] && set_env_key OPENAI_API_KEY "$inp_openai" && success "OPENAI_API_KEY"
else
  dim "  ↳ OPENAI_API_KEY already set — keeping"
fi

CURRENT_ANTHROPIC=$(get_env_val "ANTHROPIC_API_KEY")
if is_placeholder "$CURRENT_ANTHROPIC"; then
  printf "  Anthropic API key (sk-ant-...): "
  read -rs inp_anthropic; echo
  [[ -n "$inp_anthropic" ]] && set_env_key ANTHROPIC_API_KEY "$inp_anthropic" && success "ANTHROPIC_API_KEY"
else
  dim "  ↳ ANTHROPIC_API_KEY already set — keeping"
fi

# --- Write .env.local for the Vite canvas -------------------------------------
echo ""
LFPUB_FINAL=$(get_env_val "LANGFUSE_PUBLIC_KEY")

if [[ ! -f .env.local ]]; then
  cat > .env.local << EOF
# itsharness canvas — generated by setup-env.sh on $(date -u '+%Y-%m-%d %H:%M UTC')
# Vite bakes VITE_* vars at dev-server start. Never commit this file.

VITE_API_URL=http://localhost:8000
VITE_LANGFUSE_ENABLED=true
VITE_LANGFUSE_PUBLIC_KEY=${LFPUB_FINAL}
VITE_LANGFUSE_HOST=http://localhost:3001

# Real-time collab — set to ws://localhost:1234 and start with
# docker-compose.collab.yml to enable. Leave commented out to disable.
# VITE_COLLAB_SERVER_URL=
# VITE_COLLAB_OFFLINE_PERSISTENCE=true
EOF
  success ".env.local written"
else
  dim "  ↳ .env.local already exists — keeping"
fi

# --- Run check-env to confirm everything is good -----------------------------
echo ""
info "Verifying .env …"
if bash scripts/check-env.sh; then
  echo ""
  success "All secrets are set."
else
  echo ""
  error "Some secrets are still missing. Fix them in .env and re-run ./setup-env.sh"
  exit 1
fi

# ── Step 2: Python virtual environment ────────────────────────────────────────
echo ""
if ask_yes_no "Step 2 — Create Python venv and install adapter dependencies?" y; then

  PYTHON=""
  for candidate in python3.13 python3.12 python3.11 python3; do
    command -v "$candidate" &>/dev/null && { PYTHON="$candidate"; break; }
  done
  if [[ -z "$PYTHON" ]]; then
    error "python3 not found. Install Python 3.11+ and re-run."
    exit 1
  fi
  PY_VER=$("$PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
  info "Using $PYTHON ($PY_VER)"

  VENV="adapter/.venv"
  if [[ -d "$VENV" ]]; then
    info "Virtual environment already exists at $VENV — reusing."
  else
    "$PYTHON" -m venv "$VENV"
    success "Created $VENV"
  fi

  source "$VENV/bin/activate"
  pip install --quiet --upgrade pip
  pip install --quiet -r adapter/requirements.txt
  pip install --quiet -r adapter/requirements-test.txt
  success "Adapter dependencies installed into $VENV"

else
  dim "  Skipped. To do this later:"
  dim "    python3 -m venv adapter/.venv"
  dim "    source adapter/.venv/bin/activate"
  dim "    pip install -r adapter/requirements.txt -r adapter/requirements-test.txt"
fi

# ── Step 3: mastra-runner lockfile ────────────────────────────────────────────
echo ""
if [[ ! -f mastra-runner/package-lock.json ]]; then
  if ask_yes_no "Step 3 — Generate mastra-runner/package-lock.json (requires Node.js)?" y; then
    if ! command -v npm &>/dev/null; then
      warn "npm not found — skipping. Install Node.js and run: cd mastra-runner && npm install"
    else
      (cd mastra-runner && npm install --silent)
      success "mastra-runner/package-lock.json generated"
    fi
  else
    dim "  Skipped. To do this later: cd mastra-runner && npm install"
  fi
else
  dim "  ↳ mastra-runner/package-lock.json already exists — skipping."
fi

# ── Step 4: Docker stack ───────────────────────────────────────────────────────
echo ""
if ask_yes_no "Step 4 — Start the full Docker stack now?" n; then

  # Detect a stale Postgres volume — the most common startup failure.
  # If the volume exists, the password baked into it may not match the
  # current POSTGRES_PASSWORD in .env. Offer to wipe it before starting.
  if docker volume inspect itsharness_postgres_data &>/dev/null; then
    echo ""
    warn "A Postgres data volume already exists (itsharness_postgres_data)."
    echo "  If POSTGRES_PASSWORD has changed since the volume was first created,"
    echo "  Postgres will reject the new password and Langfuse will fail to start."
    echo ""
    if ask_yes_no "  Reset the data volumes now (postgres + redis + clickhouse)? All data will be lost." n; then
      info "Stopping any running containers …"
      docker compose down --timeout 10 2>/dev/null || true
      info "Removing data volumes …"
      docker volume rm \
        itsharness_postgres_data \
        itsharness_redis_data \
        itsharness_clickhouse_data \
        2>/dev/null \
        && success "Volumes removed — will reinitialise on first start" \
        || warn "Some volumes not found (may already be gone)"
    else
      dim "  Keeping existing volumes. If the stack fails with a Postgres auth error,"
      dim "  stop the stack and run:  bash scripts/reset-volumes.sh"
    fi
    echo ""
  fi

  # Rebuild canvas image if package-lock.json changed since the image was built.
  # Catches the case where new npm deps (e.g. yjs collab packages) were added to
  # package-lock.json after the image was first built, causing Vite import errors.
  _canvas_needs_rebuild() {
    # Returns 0 (true) if a rebuild is needed
    local img_created lock_file="package-lock.json"
    img_created=$(docker inspect --format=\'{{.Created}}\' itsharness-canvas 2>/dev/null) || return 0
    # Convert ISO timestamp to epoch seconds (works on macOS and Linux)
    local img_epoch
    if date --version &>/dev/null 2>&1; then
      # GNU date (Linux)
      img_epoch=$(date -d "$img_created" +%s 2>/dev/null) || return 0
    else
      # BSD date (macOS)
      img_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${img_created%%.*}" +%s 2>/dev/null) || return 0
    fi
    local lock_epoch
    lock_epoch=$(stat -f %m "$lock_file" 2>/dev/null || stat -c %Y "$lock_file" 2>/dev/null) || return 0
    [[ "$lock_epoch" -gt "$img_epoch" ]]
  }
  if _canvas_needs_rebuild; then
    warn "package-lock.json is newer than the canvas image — rebuilding to pick up new deps …"
    docker compose build --no-cache canvas
  fi

  info "Starting docker compose up …"
  docker compose up
else
  dim "  Skipped. To start the stack later:"
  dim "    docker compose up"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Setup complete.${RESET}"
echo ""
echo -e "  ${DIM}Check secrets any time:${RESET}   bash scripts/check-env.sh"
echo -e "  ${DIM}Start the stack:${RESET}           docker compose up"
echo -e "  ${DIM}Canvas:${RESET}                    http://localhost:3000"
echo -e "  ${DIM}Adapter API:${RESET}               http://localhost:8000/health"
echo -e "  ${DIM}Langfuse:${RESET}                  http://localhost:3001"
echo ""
if [[ -z "$(get_env_val OPENAI_API_KEY)" && -z "$(get_env_val ANTHROPIC_API_KEY)" ]]; then
  warn "No LLM API keys set. LLM nodes won't execute until you add one to .env."
fi
