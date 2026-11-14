#!/usr/bin/env bash
# Verify the current commit on the owner's Mac over ssh (see CLAUDE.md, "Standing rules").
#
# Exit codes: 0 pass, 1 fail, 2 bad arguments, 76 Mac unreachable or asleep (deferral:
# the plan driver turns this into PHASE_DEFERRED).
#
# Everything happens in a fresh clone under ~/bah-verify/ on the Mac. The owner's own
# checkout is never touched and nothing is written outside ~/bah-verify/. Only build and
# test output is printed; no environment, key or token is read or echoed.
#
# Usage: scripts/mac-verify.sh [--commit <sha>] [--repo <git-url>] [--poll <seconds>]
#        [--max-polls <n>] [--steps <comma list>] [--help]
# Env:   MAC_VERIFY_SSH (ssh binary, default "ssh"), MAC_VERIFY_HOST, MAC_VERIFY_KEY.
set -u

DEFER=76
SSH_BIN="${MAC_VERIFY_SSH:-ssh}"
HOST="${MAC_VERIFY_HOST:-developer@mac.fritz.box}"
KEY="${MAC_VERIFY_KEY:-$HOME/.ssh/id_ed25519_mac_screenshots}"
REPO="git@github.com:3IVIS/buildaharness.git"
COMMIT=""
POLL=20
MAX_POLLS=360
STEPS="install,runtime,harness,aielia,chat-ui,cargo-check,cargo-test"

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --poll) POLL="${2:-}"; shift 2 ;;
    --max-polls) MAX_POLLS="${2:-}"; shift 2 ;;
    --steps) STEPS="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "mac-verify: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$COMMIT" ]; then
  COMMIT="$(git rev-parse HEAD 2>/dev/null)" || { echo "mac-verify: not in a git repo and no --commit" >&2; exit 2; }
fi
case "$COMMIT" in
  *[!0-9a-f]*|"") echo "mac-verify: --commit must be a hex sha" >&2; exit 2 ;;
esac
case "$POLL$MAX_POLLS" in *[!0-9]*|"") echo "mac-verify: --poll and --max-polls must be numbers" >&2; exit 2 ;; esac
case "$STEPS$REPO" in *[\'\"\;\&\|\$\`\ ]*) echo "mac-verify: unsafe characters in --steps or --repo" >&2; exit 2 ;; esac

RUN="run-${COMMIT:0:12}"
DIR="bah-verify/$RUN" # relative to the remote $HOME

rssh() {
  "$SSH_BIN" -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "$@"
}

# Returns 0 when the ssh stderr text means the Mac cannot be reached.
unreachable() {
  case "$1" in
    *"No route to host"*|*"timed out"*|*"Host is down"*|*"Network is unreachable"*|*"Connection refused"*|*"Could not resolve hostname"*) return 0 ;;
  esac
  return 1
}

ERR="$(mktemp)"; trap 'rm -f "$ERR"' EXIT

# Remote build script, uploaded as a file inside the run directory.
REMOTE_SCRIPT=$(cat <<'REMOTE'
set -u
cd "$HOME/__DIR__" || exit 1
status=0
step() { # name, dir, command...
  name="$1"; dir="$2"; shift 2
  case ",__STEPS__," in *",$name,"*) ;; *) return 0 ;; esac
  echo "== step $name"
  ( cd "repo/$dir" && "$@" ) || { echo "== step $name FAILED"; status=1; return 1; }
}
rm -rf repo
git clone --quiet __REPO__ repo || { echo "== clone FAILED"; echo 1 > status; exit 1; }
( cd repo && git checkout --quiet __COMMIT__ ) || { echo "== checkout FAILED (is the commit pushed?)"; echo 1 > status; exit 1; }
export CARGO_TARGET_DIR="$HOME/Documents/Projects/buildaharness/packages/desktop/src-tauri/target"
[ -d "$CARGO_TARGET_DIR" ] || export CARGO_TARGET_DIR="$HOME/bah-verify/target"
step install . npm ci &&
step runtime packages/runtime npm run build &&
step harness packages/harness npm run build &&
step aielia packages/aielia npm run build &&
step chat-ui packages/chat-ui npm run build &&
step cargo-check packages/desktop/src-tauri cargo check --locked &&
step cargo-test packages/desktop/src-tauri cargo test --locked
echo $status > status
[ "$status" = 0 ] && echo "== all steps passed"
REMOTE
)
REMOTE_SCRIPT="${REMOTE_SCRIPT//__DIR__/$DIR}"
REMOTE_SCRIPT="${REMOTE_SCRIPT//__STEPS__/$STEPS}"
REMOTE_SCRIPT="${REMOTE_SCRIPT//__REPO__/$REPO}"
REMOTE_SCRIPT="${REMOTE_SCRIPT//__COMMIT__/$COMMIT}"

# Step 1: create the run directory and upload the script (only under ~/bah-verify/).
if ! printf '%s\n' "$REMOTE_SCRIPT" | rssh "mkdir -p \"\$HOME/$DIR\" && rm -f \"\$HOME/$DIR/status\" && cat > \"\$HOME/$DIR/run.sh\"" 2>"$ERR"; then
  if unreachable "$(cat "$ERR")"; then echo "mac-verify: Mac unreachable (asleep or off the LAN): deferring" >&2; exit "$DEFER"; fi
  cat "$ERR" >&2; echo "mac-verify: could not prepare the run directory" >&2; exit 1
fi

# Step 2: start it in the background with a login shell (needed for PATH).
if ! rssh "cd \"\$HOME/$DIR\" && : > log && nohup zsh -lic 'bash run.sh' > log 2>&1 < /dev/null &" 2>"$ERR"; then
  if unreachable "$(cat "$ERR")"; then exit "$DEFER"; fi
  cat "$ERR" >&2; echo "mac-verify: could not start the run" >&2; exit 1
fi

# Step 3: poll the log; print only new lines.
shown=0; polls=0; lost=0
while [ "$polls" -lt "$MAX_POLLS" ]; do
  sleep "$POLL"; polls=$((polls + 1))
  out="$(rssh "cd \"\$HOME/$DIR\" && tail -n +$((shown + 1)) log; echo \"@@STATUS:\$(cat status 2>/dev/null)\"" 2>"$ERR")" || {
    if unreachable "$(cat "$ERR")"; then
      lost=$((lost + 1)); [ "$lost" -ge 3 ] && { echo "mac-verify: lost the Mac while running: deferring" >&2; exit "$DEFER"; }
      continue
    fi
    cat "$ERR" >&2; echo "mac-verify: polling failed" >&2; exit 1
  }
  lost=0
  body="${out%@@STATUS:*}"; st="${out##*@@STATUS:}"
  if [ -n "$body" ]; then printf '%s' "$body"; shown=$((shown + $(printf '%s' "$body" | wc -l))); fi
  case "$st" in
    0) echo "mac-verify: PASS ($COMMIT)"; exit 0 ;;
    "") ;;
    *) echo "mac-verify: FAIL ($COMMIT)"; exit 1 ;;
  esac
done
echo "mac-verify: timed out waiting for the run (still going on the Mac in ~/$DIR)" >&2
exit 1
