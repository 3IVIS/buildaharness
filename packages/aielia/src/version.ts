/**
 * The CLI's own version, checked into git so it is available without reading package.json at
 * runtime (a bundled/SEA binary has no package.json beside it). `scripts/check-cli-version-sync.mjs`
 * fails CI if this drifts from `package.json`'s `version` — bump both together.
 */
export const CLI_VERSION = '0.3.4'
