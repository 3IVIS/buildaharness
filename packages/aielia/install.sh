#!/bin/sh
# Aielia CLI installer — macOS and Linux.
#
#   curl -fsSL https://myaielia.com/install.sh | sh
#   curl -fsSL https://myaielia.com/install.sh | sh -s -- --force
#
# Resolves the product-scoped manifest https://myaielia.com/aielia-latest.json (never GitHub's
# repo-wide /releases/latest, which is shared with every other *-v* release line), downloads the
# binary for this platform from the tag-scoped release URL it names, verifies its sha256 against
# the manifest (the sidecar `<asset>.sha256` is a cross-check: it must agree if reachable), and
# installs it to ${AIELIA_INSTALL_DIR:-$HOME/.local/bin}/aielia.
#
# Idempotent: re-running upgrades in place, or says "already up to date". Refuses to overwrite an
# unrelated file (or a symlink, e.g. an npm-linked `aielia`) at the target path without --force.
# HTTPS only (curl --proto '=https' --tlsv1.2). Windows: use install.ps1.
#
# Test-only: AIELIA_MANIFEST_URL overrides the manifest URL; setting AIELIA_INSTALL_ALLOW_INSECURE=1
# additionally lets it (and the asset URLs it names) use http:// or file://. Never set these in real use.
#
# Everything lives in main() and is only invoked on the last line, so a truncated `curl | sh`
# download can never execute half a script.

set -eu

DEFAULT_MANIFEST_URL='https://myaielia.com/aielia-latest.json'

say() { printf '%s\n' "$*"; }
die() { printf 'aielia install: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [--force] [--help]

  --force   replace an existing file at the install path even if it isn't an aielia binary
  --help    show this message

Environment:
  AIELIA_INSTALL_DIR   install directory (default: $HOME/.local/bin)
EOF
}

# --- HTTP ---------------------------------------------------------------------------------------

curl_proto() {
  if [ "${AIELIA_INSTALL_ALLOW_INSECURE:-}" = "1" ]; then
    printf '%s' '=https,http,file'
  else
    printf '%s' '=https'
  fi
}

# Hard-fail on any non-HTTPS URL (unless the test-only override is set).
require_https() {
  case "$1" in
    https://*) ;;
    http://*|file://*)
      [ "${AIELIA_INSTALL_ALLOW_INSECURE:-}" = "1" ] || die "refusing non-HTTPS URL: $1"
      ;;
    *) die "refusing non-HTTPS URL: $1" ;;
  esac
}

# fetch <url> <dest>
fetch() {
  require_https "$1"
  curl --proto "$(curl_proto)" --proto-redir "$(curl_proto)" --tlsv1.2 -fsSL --retry 2 -o "$2" "$1"
}

# --- platform / manifest parsing ----------------------------------------------------------------

detect_platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux)  os=linux ;;
    Darwin) os=darwin ;;
    MINGW*|MSYS*|CYGWIN*) die "this looks like Windows — use install.ps1 instead: irm https://myaielia.com/install.ps1 | iex" ;;
    *) die "unsupported OS: $os (supported: macOS, Linux; Windows via install.ps1)" ;;
  esac
  case "$arch" in
    x86_64|amd64)  arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) die "unsupported CPU architecture: $arch" ;;
  esac
  # A shell running under Rosetta reports x86_64 on an Apple Silicon Mac; prefer the native binary.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
    arch=arm64
  fi
  case "$os-$arch" in
    linux-x64|darwin-arm64|darwin-x64) ;;
    *) die "no prebuilt aielia binary for $os-$arch yet — use: npx @buildaharness/aielia" ;;
  esac
  PLATFORM_KEY="$os-$arch"
}

# manifest_field <manifest-file> <platform-key> <field>
# The manifest is emitted by scripts/generate-aielia-manifest.mjs as JSON.stringify(_, null, 2):
# one key per line, so an awk scan of the `"<platform-key>": {` block is enough (no jq needed).
manifest_field() {
  awk -v key="$2" -v field="$3" '
    $0 ~ "^[ \t]*\"" key "\"[ \t]*:[ \t]*\\{" { inblock = 1; next }
    inblock && /^[ \t]*\}/ { exit }
    inblock {
      pat = "^[ \t]*\"" field "\"[ \t]*:[ \t]*"
      if ($0 ~ pat) {
        v = $0
        sub(pat, "", v)
        sub(/[ \t]*,?[ \t]*$/, "", v)
        gsub(/^"|"$/, "", v)
        print v
        exit
      }
    }
  ' "$1"
}

manifest_top_field() {
  # Top-level string field (2-space indent), e.g. "version".
  sed -n 's/^  "'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' "$1" | head -n 1
}

# --- checksum -----------------------------------------------------------------------------------

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print tolower($1)}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print tolower($NF)}'
  else
    die "no sha256 tool found (need sha256sum, shasum, or openssl)"
  fi
}

# --- main ---------------------------------------------------------------------------------------

main() {
  force=0
  for a in "$@"; do
    case "$a" in
      --force) force=1 ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $a" ;;
    esac
  done

  command -v curl >/dev/null 2>&1 || die "curl is required"

  [ -n "${HOME:-}" ] || [ -n "${AIELIA_INSTALL_DIR:-}" ] || die "\$HOME is not set; set AIELIA_INSTALL_DIR"
  install_dir=${AIELIA_INSTALL_DIR:-$HOME/.local/bin}
  target=$install_dir/aielia
  manifest_url=${AIELIA_MANIFEST_URL:-$DEFAULT_MANIFEST_URL}

  detect_platform

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/aielia-install.XXXXXX") || die "could not create a temp directory"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  say "Fetching the Aielia release manifest…"
  fetch "$manifest_url" "$tmp/manifest.json" || die "could not download $manifest_url"

  tag=$(manifest_top_field "$tmp/manifest.json" tag)
  version=$(manifest_top_field "$tmp/manifest.json" version)
  asset_url=$(manifest_field "$tmp/manifest.json" "$PLATFORM_KEY" url)
  expected=$(manifest_field "$tmp/manifest.json" "$PLATFORM_KEY" sha256)

  case "$tag" in aielia-v*) ;; *) die "manifest carries an unexpected tag: '${tag:-<none>}'" ;; esac
  [ -n "$asset_url" ] || die "release $tag has no binary for $PLATFORM_KEY"
  case "$expected" in
    *[!0-9a-fA-F]*|'') die "manifest has no valid sha256 for $PLATFORM_KEY" ;;
  esac
  [ "${#expected}" -eq 64 ] || die "manifest has no valid sha256 for $PLATFORM_KEY"
  expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
  require_https "$asset_url"

  # Existing file at the target path: upgrade an aielia binary, refuse anything else without --force.
  if [ -e "$target" ] || [ -L "$target" ]; then
    installed=
    if [ -f "$target" ] && [ ! -L "$target" ] && [ -x "$target" ]; then
      installed=$("$target" --version 2>/dev/null | head -n 1 || true)
    fi
    case "$installed" in
      [0-9]*.[0-9]*.[0-9]*)
        if [ "$installed" = "$version" ]; then
          say "aielia $installed is already installed at $target — up to date."
          exit 0
        fi
        say "Upgrading aielia $installed → $version"
        ;;
      *)
        if [ "$force" -ne 1 ]; then
          die "$target already exists and is not an aielia binary (or is a symlink, e.g. from npm). Re-run with --force to replace it."
        fi
        say "Replacing existing $target (--force)"
        ;;
    esac
  else
    say "Installing aielia $version"
  fi

  say "Downloading $asset_url"
  fetch "$asset_url" "$tmp/aielia" || die "download failed: $asset_url"

  actual=$(sha256_of "$tmp/aielia")
  [ "$actual" = "$expected" ] || die "checksum mismatch (manifest $expected, downloaded $actual) — download discarded"

  # The sidecar next to the binary is a cross-check on a different origin: if reachable it must agree.
  if fetch "$asset_url.sha256" "$tmp/aielia.sha256" 2>/dev/null; then
    sidecar=$(tr -d '\r' < "$tmp/aielia.sha256" | grep -Eo '[0-9a-fA-F]{64}' | head -n 1 | tr 'A-F' 'a-f' || true)
    if [ -n "$sidecar" ] && [ "$sidecar" != "$expected" ]; then
      die "checksum sidecar disagrees with the release manifest — download discarded"
    fi
  fi
  say "Checksum verified (sha256 $actual)"

  mkdir -p "$install_dir" || die "could not create $install_dir"
  # Stage beside the target, then rename over it: the swap is atomic and works while the old binary runs.
  staged=$install_dir/.aielia.install.$$
  cp "$tmp/aielia" "$staged" || die "could not write to $install_dir"
  chmod 755 "$staged"
  # Only a --force'd unrelated file/symlink is removed first (mv over a directory would misbehave).
  if [ -d "$target" ] && [ ! -L "$target" ]; then rm -f "$staged"; die "$target is a directory"; fi
  mv -f "$staged" "$target" || { rm -f "$staged"; die "could not install to $target"; }

  say "Installed aielia $version to $target"

  case ":${PATH:-}:" in
    *":$install_dir:"*) ;;
    *)
      say ""
      say "$install_dir is not on your PATH. Add it, e.g.:"
      say "  echo 'export PATH=\"$install_dir:\$PATH\"' >> ~/.profile   # then restart your shell"
      ;;
  esac
  say ""
  say "Run: aielia        (updates later: aielia update)"
}

main "$@"
