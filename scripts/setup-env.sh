#!/usr/bin/env bash
# setup-env.sh — first-time setup (and re-run safe repair) for buildaharness.
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

# Write or replace a key=value line in a given file.
# If the key exists (even with a placeholder), replaces it in place.
# If it doesn't exist, appends it.
_set_key_in_file() {
  local file="$1" key="$2" value="$3"
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    if [[ "$(uname)" == "Darwin" ]]; then
      sed -i '' "s|^${key}=.*|${key}=${value}|" "$file"
    else
      sed -i    "s|^${key}=.*|${key}=${value}|" "$file"
    fi
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# Write or replace a key in BOTH .env and .env.bak (keeps them in sync).
set_env_key_both() {
  _set_key_in_file .env     "$1" "$2"
  _set_key_in_file .env.bak "$1" "$2"
}

is_placeholder() {
  # Returns 0 (true) if the value looks like a placeholder or is empty
  local val="$1"
  [[ -z "$val" ]] && return 0
  local placeholders=("REPLACE_ME" "REPLACE_WITH_REAL" "your_password"
                      "changeme" "placeholder" "YOUR_"
                      "sk-ant-REPLACE" "sk-REPLACE"
                      "sk-ant-..." "sk-..." "...")
  for p in "${placeholders[@]}"; do
    [[ "$val" == *"$p"* ]] && return 0
  done
  return 1
}

get_env_val() {
  # Reads from .env first; falls back to .env.bak so existing values seed .env.
  local val
  val=$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2-)
  if [[ -z "$val" ]]; then
    val=$(grep -E "^$1=" .env.bak 2>/dev/null | tail -1 | cut -d= -f2-)
  fi
  echo "$val"
}

# ── Preflight ──────────────────────────────────────────────────────────────────
header "buildaharness — setup"

if ! command -v openssl &>/dev/null; then
  error "openssl not found. Install it and re-run."; exit 1
fi

# Use the tracked hooks in .githooks/ (e.g. the pre-commit guard that blocks
# .private.git/ and test_convs/ from ever being staged — see .githooks/pre-commit).
# Local .git/hooks/ isn't version-controlled, so every fresh clone needs this.
git config core.hooksPath .githooks
success "Configured git to use .githooks/ (blocks committing .private.git/, test_convs/)"

# If a private overlay (.private.git) is present locally, it tracks a source
# file naming every individually-private path (.git-private-excludes-source —
# never committed to THIS repo, see .gitignore's own comment on
# .git-private-excludes for why). Provision a local-only copy outside the
# working tree and point this repo's core.excludesFile at it, so those paths
# are excluded from `git status`/`git add` here too, without their names ever
# living inside a file this repo could commit. Deliberately generic: this
# script doesn't know or care what's in that file, only whether it exists.
if [[ -f .git-private-excludes-source ]]; then
  private_excludes_dir="${XDG_CONFIG_HOME:-$HOME/.config}/buildaharness"
  mkdir -p "$private_excludes_dir"
  cp .git-private-excludes-source "$private_excludes_dir/git-private-excludes"
  git config core.excludesFile "$private_excludes_dir/git-private-excludes"
  success "Configured core.excludesFile from the private overlay's path list ($private_excludes_dir/git-private-excludes)"
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
    set_env_key_both "$key" "$val"
    success "$key"
  else
    dim "  ↳ $key already set — keeping"
  fi
}

_fix_secret JWT_SECRET               'rand_base64 32'
_fix_secret POSTGRES_PASSWORD        'rand_base64 24'
_fix_secret REDIS_PASSWORD           'rand_base64 24'

# DATABASE_URL — build from POSTGRES_PASSWORD so they're always in sync.
# Replaces placeholder password AND fixes localhost → postgres (Docker service name).
_fix_database_url() {
  local pg_pass current_url
  pg_pass=$(get_env_val "POSTGRES_PASSWORD")
  current_url=$(get_env_val "DATABASE_URL")
  local needs_fix=false

  # Fix if password is still a placeholder
  if echo "$current_url" | grep -qE "REPLACE_WITH_REAL|REPLACE_ME|changeme|placeholder"; then
    needs_fix=true
  fi
  # Fix if the password in the URL doesn't match POSTGRES_PASSWORD
  local url_pass
  url_pass=$(echo "$current_url" | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')
  if [[ -n "$pg_pass" && "$url_pass" != "$pg_pass" ]]; then
    needs_fix=true
  fi

  if $needs_fix; then
    local new_url="postgresql+asyncpg://buildaharness:${pg_pass}@postgres:5432/buildaharness"
    set_env_key_both DATABASE_URL "$new_url"
    success "DATABASE_URL"
  else
    dim "  ↳ DATABASE_URL already set — keeping"
  fi
}
_fix_database_url
_fix_secret LITELLM_MASTER_KEY       'rand_base64 32'
_fix_secret LANGFUSE_NEXTAUTH_SECRET 'rand_base64 32'
_fix_secret LANGFUSE_SALT            'rand_base64 32'
_fix_secret LANGFUSE_ENCRYPTION_KEY  'rand_hex 32' \
  '[[ ${#current} -eq 64 ]] && [[ "$current" =~ ^[0-9a-fA-F]{64}$ ]]'
_fix_secret CLICKHOUSE_PASSWORD      'rand_hex 24'
_fix_secret MASTRA_RUNNER_API_KEY    'rand_base64 32'

# REDIS_URL — build from REDIS_PASSWORD so they're always in sync and concrete
# (Docker Compose interpolates ${REDIS_PASSWORD} itself, but Python dotenv does not).
_fix_redis_url() {
  local redis_pass current_url
  redis_pass=$(get_env_val "REDIS_PASSWORD")
  current_url=$(get_env_val "REDIS_URL")

  local needs_fix=false
  if echo "$current_url" | grep -qE 'REPLACE_WITH_REAL|REPLACE_ME|changeme|placeholder|\$\{REDIS_PASSWORD\}'; then
    needs_fix=true
  fi
  local url_pass
  url_pass=$(echo "$current_url" | sed -E 's|.*://:([^@]+)@.*|\1|')
  if [[ -n "$redis_pass" && "$url_pass" != "$redis_pass" ]]; then
    needs_fix=true
  fi

  if $needs_fix; then
    local new_url="redis://:${redis_pass}@redis:6379/1"
    set_env_key_both REDIS_URL "$new_url"
    success "REDIS_URL"
  else
    dim "  ↳ REDIS_URL already set — keeping"
  fi
}
_fix_redis_url

# Langfuse API key pair — generate together so they stay consistent
LFPUB=$(get_env_val "LANGFUSE_PUBLIC_KEY")
LFSEC=$(get_env_val "LANGFUSE_SECRET_KEY")
if is_placeholder "$LFPUB" || is_placeholder "$LFSEC"; then
  set_env_key_both LANGFUSE_PUBLIC_KEY "pk-lf-$(rand_hex 16)"
  set_env_key_both LANGFUSE_SECRET_KEY "sk-lf-$(rand_hex 16)"
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
  set_env_key_both LANGFUSE_ADMIN_EMAIL "${inp_email:-admin@example.com}"
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
  set_env_key_both LANGFUSE_ADMIN_PASSWORD "$inp_pw"
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
  [[ -n "$inp_openai" ]] && set_env_key_both OPENAI_API_KEY "$inp_openai" && success "OPENAI_API_KEY"
else
  dim "  ↳ OPENAI_API_KEY already set — keeping"
fi

CURRENT_ANTHROPIC=$(get_env_val "ANTHROPIC_API_KEY")
if is_placeholder "$CURRENT_ANTHROPIC"; then
  printf "  Anthropic API key (sk-ant-...): "
  read -rs inp_anthropic; echo
  [[ -n "$inp_anthropic" ]] && set_env_key_both ANTHROPIC_API_KEY "$inp_anthropic" && success "ANTHROPIC_API_KEY"
else
  dim "  ↳ ANTHROPIC_API_KEY already set — keeping"
fi

# Flow-specific callable modules for the Mastra fn_ref bridge
echo ""
info "Flow configuration (optional — press Enter to keep existing or skip):"
echo ""

CURRENT_EXTRA_MODS=$(get_env_val "EXTRA_CALLABLE_MODULES")
if [[ -z "$CURRENT_EXTRA_MODS" ]]; then
  printf "  Extra callable modules for fn_ref nodes (comma-separated, e.g. my_tools,my_utils): "
  read -r inp_extra_mods
  if [[ -n "$inp_extra_mods" ]]; then
    set_env_key_both EXTRA_CALLABLE_MODULES "$inp_extra_mods"
    success "EXTRA_CALLABLE_MODULES"
  else
    dim "  ↳ EXTRA_CALLABLE_MODULES left unset — only built-in modules will be callable via fn_ref"
  fi
else
  dim "  ↳ EXTRA_CALLABLE_MODULES already set (${CURRENT_EXTRA_MODS}) — keeping"
fi

# --- Write .env.local for the Vite canvas -------------------------------------
echo ""
LFPUB_FINAL=$(get_env_val "LANGFUSE_PUBLIC_KEY")

_write_env_local() {
  cat > .env.local << EOF
# buildaharness canvas — generated by setup-env.sh on $(date -u '+%Y-%m-%d %H:%M UTC')
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
}

if [[ ! -f .env.local ]]; then
  _write_env_local
  success ".env.local written"
else
  # Sync VITE_LANGFUSE_PUBLIC_KEY from .env — they must match
  current_vite_key=$(grep -E "^VITE_LANGFUSE_PUBLIC_KEY=" .env.local | cut -d= -f2-)
  if [[ "$current_vite_key" != "$LFPUB_FINAL" ]]; then
    if [[ "$(uname)" == "Darwin" ]]; then
      sed -i '' "s|^VITE_LANGFUSE_PUBLIC_KEY=.*|VITE_LANGFUSE_PUBLIC_KEY=${LFPUB_FINAL}|" .env.local
    else
      sed -i    "s|^VITE_LANGFUSE_PUBLIC_KEY=.*|VITE_LANGFUSE_PUBLIC_KEY=${LFPUB_FINAL}|" .env.local
    fi
    warn ".env.local VITE_LANGFUSE_PUBLIC_KEY updated to match .env"
  else
    dim "  ↳ .env.local VITE_LANGFUSE_PUBLIC_KEY is in sync — keeping"
  fi

  # Ensure required static VITE keys are present (may be missing if .env.local predates them)
  declare -A _VITE_DEFAULTS=(
    [VITE_API_URL]="http://localhost:8000"
    [VITE_LANGFUSE_ENABLED]="true"
    [VITE_LANGFUSE_HOST]="http://localhost:3001"
  )
  for vk in VITE_API_URL VITE_LANGFUSE_ENABLED VITE_LANGFUSE_HOST; do
    if ! grep -qE "^${vk}=" .env.local; then
      printf '\n%s=%s\n' "$vk" "${_VITE_DEFAULTS[$vk]}" >> .env.local
      warn ".env.local missing ${vk} — added with default value"
    fi
  done
fi

# --- Sync .env → .env.bak and cross-check for drift ---------------------------
echo ""
info "Syncing secrets to .env.bak and checking for drift …"

SYNC_KEYS=(
  JWT_SECRET POSTGRES_PASSWORD REDIS_PASSWORD DATABASE_URL REDIS_URL
  LITELLM_MASTER_KEY MASTRA_RUNNER_API_KEY
  LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_ADMIN_EMAIL
  LANGFUSE_ADMIN_PASSWORD LANGFUSE_NEXTAUTH_SECRET LANGFUSE_SALT
  LANGFUSE_ENCRYPTION_KEY CLICKHOUSE_PASSWORD OPENAI_API_KEY ANTHROPIC_API_KEY
)

DRIFT_FOUND=0
if [[ ! -f .env.bak ]]; then
  cp .env .env.bak
  success ".env.bak created from .env"
else
  for key in "${SYNC_KEYS[@]}"; do
    v_env=$(grep -E "^${key}=" .env     2>/dev/null | tail -1 | cut -d= -f2-)
    v_bak=$(grep -E "^${key}=" .env.bak 2>/dev/null | tail -1 | cut -d= -f2-)
    if [[ -n "$v_env" && "$v_env" != "$v_bak" ]]; then
      warn "DRIFT: $key differs between .env and .env.bak — updating .env.bak"
      _set_key_in_file .env.bak "$key" "$v_env"
      DRIFT_FOUND=1
    fi
  done
  if [[ $DRIFT_FOUND -eq 0 ]]; then
    success ".env and .env.bak are in sync"
  else
    success ".env.bak updated to match .env"
  fi
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
  if docker volume inspect buildaharness_postgres_data &>/dev/null; then
    echo ""
    warn "A Postgres data volume already exists (buildaharness_postgres_data)."
    echo "  If POSTGRES_PASSWORD has changed since the volume was first created,"
    echo "  Postgres will reject the new password and Langfuse will fail to start."
    echo ""
    if ask_yes_no "  Reset the data volumes now (postgres + redis + clickhouse)? All data will be lost." n; then
      info "Stopping any running containers …"
      docker compose down --timeout 10 2>/dev/null || true
      info "Removing data volumes …"
      docker volume rm \
        buildaharness_postgres_data \
        buildaharness_redis_data \
        buildaharness_clickhouse_data \
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
    img_created=$(docker inspect --format=\'{{.Created}}\' buildaharness-canvas 2>/dev/null) || return 0
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
