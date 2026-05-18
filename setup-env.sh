#!/usr/bin/env bash
# setup-env.sh — first-time setup for itsharness
#
# Works on macOS and Linux. Requires: openssl, python3 (3.11+).
# Run from the project root:
#   chmod +x setup-env.sh
#   ./setup-env.sh
#
# The script will:
#   1. Create an isolated Python virtual environment at adapter/.venv
#   2. Install adapter + test dependencies into it (no global packages touched)
#   3. Check for an existing .env and ask before overwriting
#   4. Generate all cryptographic secrets automatically
#   5. Prompt for values that can't be auto-generated (API keys, email)
#   6. Write a ready-to-use .env
#   7. Write a ready-to-use .env.local for the Vite canvas

set -euo pipefail

# ── Helpers ───────────────────────────────────────────────────────────────────

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
RED="\033[31m"
RESET="\033[0m"

info()    { echo -e "${CYAN}▸${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET}  $*"; }
error()   { echo -e "${RED}✗${RESET} $*" >&2; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

prompt_value() {
  local var="$1" label="$2" default="$3" secret="${4:-}"
  local value
  if [[ -n "$secret" ]]; then
    printf "  %s" "$label"
    [[ -n "$default" ]] && printf " [leave blank to skip]"
    printf ": "
    read -rs value
    echo
  else
    printf "  %s" "$label"
    [[ -n "$default" ]] && printf " [%s]" "$default"
    printf ": "
    read -r value
  fi
  [[ -z "$value" && -n "$default" ]] && value="$default"
  printf -v "$var" '%s' "$value"
}

rand_base64() { openssl rand -base64 "$1" | tr -d '\n='; }
rand_hex()    { openssl rand -hex "$1"; }

# ── Preflight ─────────────────────────────────────────────────────────────────

header "itsharness — first-time setup"

if ! command -v openssl &>/dev/null; then
  error "openssl not found. Install it (brew install openssl on Mac) and re-run."
  exit 1
fi

# Resolve the python3 binary (prefer newer versions if available)
PYTHON=""
for candidate in python3.13 python3.12 python3.11 python3; do
  if command -v "$candidate" &>/dev/null; then
    PYTHON="$candidate"
    break
  fi
done
if [[ -z "$PYTHON" ]]; then
  error "python3 not found. Install Python 3.11+ and re-run."
  exit 1
fi
PY_VERSION=$("$PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
info "Using $PYTHON ($PY_VERSION)"

# ── Virtual environment ───────────────────────────────────────────────────────

VENV_DIR="adapter/.venv"
header "Python virtual environment"

if [[ -d "$VENV_DIR" ]]; then
  info "Virtual environment already exists at $VENV_DIR — reusing."
else
  info "Creating virtual environment at $VENV_DIR ..."
  "$PYTHON" -m venv "$VENV_DIR"
  success "Virtual environment created"
fi

# Activate for the remainder of this script
source "$VENV_DIR/bin/activate"

info "Upgrading pip ..."
pip install --quiet --upgrade pip

header "Installing Python dependencies"
info "adapter/requirements.txt ..."
pip install --quiet -r adapter/requirements.txt

info "adapter/requirements-test.txt ..."
pip install --quiet -r adapter/requirements-test.txt

success "All packages installed into $VENV_DIR (global Python untouched)"

# ── .env setup ────────────────────────────────────────────────────────────────

DO_ENV=true
if [[ -f .env ]]; then
  warn ".env already exists."
  printf "  Overwrite it? [y/N] "
  read -r overwrite
  [[ "${overwrite,,}" == "y" ]] || DO_ENV=false
fi

if $DO_ENV; then

  # ── Collect human-supplied values ──────────────────────────────────────────

  header "LLM API keys"
  echo "  Passed straight to LiteLLM. You can add more later in .env."
  prompt_value OPENAI_API_KEY    "OpenAI API key (sk-...)"        ""
  prompt_value ANTHROPIC_API_KEY "Anthropic API key (sk-ant-...)" "" secret

  header "Langfuse admin account"
  echo "  Created on first docker compose up. Use these to log in at localhost:3001."
  prompt_value LANGFUSE_ADMIN_EMAIL    "Admin email"    "admin@example.com"
  prompt_value LANGFUSE_ADMIN_PASSWORD "Admin password" "" secret
  if [[ -z "$LANGFUSE_ADMIN_PASSWORD" ]]; then
    LANGFUSE_ADMIN_PASSWORD="$(rand_base64 16)"
    warn "No password entered — generated one (see .env after this runs)"
  fi

  # ── Generate cryptographic secrets ─────────────────────────────────────────

  header "Generating secrets"

  JWT_SECRET="$(rand_base64 32)";         success "JWT_SECRET"
  POSTGRES_PASSWORD="$(rand_base64 24)";  success "POSTGRES_PASSWORD"
  LITELLM_MASTER_KEY="$(rand_base64 32)"; success "LITELLM_MASTER_KEY"

  LANGFUSE_PUBLIC_KEY="pk-lf-$(rand_hex 16)"
  LANGFUSE_SECRET_KEY="sk-lf-$(rand_hex 16)"
  success "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY"

  LANGFUSE_NEXTAUTH_SECRET="$(rand_base64 32)"; success "LANGFUSE_NEXTAUTH_SECRET"
  LANGFUSE_SALT="$(rand_base64 32)";            success "LANGFUSE_SALT"
  LANGFUSE_ENCRYPTION_KEY="$(rand_hex 32)";     success "LANGFUSE_ENCRYPTION_KEY"
  CLICKHOUSE_PASSWORD="$(rand_hex 24)";         success "CLICKHOUSE_PASSWORD"  # hex avoids / and + breaking ClickHouse migration URLs

  # ── Write .env ─────────────────────────────────────────────────────────────

  header "Writing .env"
  cat > .env <<EOF
# itsharness — generated by setup-env.sh on $(date -u '+%Y-%m-%d %H:%M UTC')
# Never commit this file.

# ── LLM API keys ─────────────────────────────────────────────────────────────
OPENAI_API_KEY=${OPENAI_API_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}

# ── Auth ─────────────────────────────────────────────────────────────────────
JWT_SECRET=${JWT_SECRET}

# ── Database ─────────────────────────────────────────────────────────────────
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

# Full async connection URL. Docker Compose builds this from POSTGRES_PASSWORD
# automatically; when running python main.py locally you need it here.
# To use the Postgres container: start docker compose first, then run main.py.
# To use SQLite instead (no Postgres needed, dev only):
#   DATABASE_URL=sqlite+aiosqlite:///./itsharness_dev.db
DATABASE_URL=postgresql+asyncpg://itsharness:${POSTGRES_PASSWORD}@localhost:5432/itsharness

# ── LiteLLM proxy ────────────────────────────────────────────────────────────
LITELLM_MASTER_KEY=${LITELLM_MASTER_KEY}

# ── Langfuse (self-hosted) ───────────────────────────────────────────────────
LANGFUSE_PUBLIC_KEY=${LANGFUSE_PUBLIC_KEY}
LANGFUSE_SECRET_KEY=${LANGFUSE_SECRET_KEY}

LANGFUSE_ADMIN_EMAIL=${LANGFUSE_ADMIN_EMAIL}
LANGFUSE_ADMIN_PASSWORD=${LANGFUSE_ADMIN_PASSWORD}

LANGFUSE_NEXTAUTH_SECRET=${LANGFUSE_NEXTAUTH_SECRET}
LANGFUSE_SALT=${LANGFUSE_SALT}
LANGFUSE_ENCRYPTION_KEY=${LANGFUSE_ENCRYPTION_KEY}

# ── ClickHouse ───────────────────────────────────────────────────────────────
CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD}

# ── CORS ─────────────────────────────────────────────────────────────────────
CORS_ORIGINS=http://localhost:3000,http://canvas:3000

# ── Tuning (safe defaults) ───────────────────────────────────────────────────
JOB_TTL_HOURS=4
JWT_TTL_DAYS=30
MAX_BODY_BYTES=1048576
EOF
  success ".env written"

  # ── Write .env.local ───────────────────────────────────────────────────────

  header "Writing .env.local"
  cat > .env.local <<EOF
# itsharness canvas — generated by setup-env.sh on $(date -u '+%Y-%m-%d %H:%M UTC')
# Vite bakes VITE_* vars at dev-server start. Never commit this file.

VITE_API_URL=http://localhost:8000
VITE_LANGFUSE_ENABLED=true
VITE_LANGFUSE_PUBLIC_KEY=${LANGFUSE_PUBLIC_KEY}
VITE_LANGFUSE_HOST=http://localhost:3001
EOF
  success ".env.local written"

fi   # end DO_ENV

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}Setup complete.${RESET}"
echo ""
echo "  Activate the virtual environment in your shell:"
echo -e "    ${CYAN}source adapter/.venv/bin/activate${RESET}"
echo ""
echo "  Run the adapter locally (requires Postgres — start the DB container first):"
echo -e "    ${CYAN}docker compose up postgres -d${RESET}"
echo -e "    ${CYAN}source adapter/.venv/bin/activate && cd adapter && python main.py${RESET}"
echo ""
echo "  Or use SQLite for dev (no Postgres needed) — set DATABASE_URL in .env:"
echo -e "    ${CYAN}DATABASE_URL=sqlite+aiosqlite:///./itsharness_dev.db${RESET}"
echo ""
echo "  Run the test suite:"
echo -e "    ${CYAN}source adapter/.venv/bin/activate && pytest adapter/tests/ -v${RESET}"
echo ""
echo "  Start the full Docker stack:"
echo -e "    ${CYAN}docker compose up${RESET}"
echo -e "    Canvas   → http://localhost:3000"
echo -e "    Adapter  → http://localhost:8000/health"
echo -e "    Langfuse → http://localhost:3001"
echo ""

if [[ -z "${OPENAI_API_KEY:-}" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  warn "No LLM API keys were entered. LLM nodes won't work until you add at least one to .env."
fi
