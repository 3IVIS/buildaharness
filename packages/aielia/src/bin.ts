/**
 * The packaged CLI's actual entry point (vite.config.lib.ts's "cli" build entry — the source
 * of dist/cli.js, referenced by package.json's "bin"). Deliberately not cli.ts itself: cli.ts's
 * own `if (isEntryModule()) void main()` guard compares `import.meta.url` against
 * `process.argv[1]`, which only works when cli.ts's code ends up in the exact file Node was
 * invoked with — true for `tsx src/cli.ts`, but not once bundled, since tui-app.tsx's static
 * import of cli.ts forces Vite/Rollup to hoist cli.ts's code into a shared chunk and turn
 * dist/cli.js into a facade re-exporting it; import.meta.url inside that shared chunk is never
 * dist/cli.js's own URL, so the guard silently evaluates false and the packaged CLI exited 0
 * with no REPL. This file has no other importers, so Rollup has no reason to ever share or
 * facade it — it's guaranteed to be the literal content of dist/cli.js — and it calls main()
 * unconditionally rather than trying to detect "am I the entry point" at all.
 */
import { main } from './cli.js'

void main()
