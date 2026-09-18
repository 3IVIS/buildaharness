import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    dts({
      include: ['src'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.test.mts'],
      insertTypesEntry: true,
      tsconfigPath: resolve(__dirname, 'tsconfig.json'),
    }),
  ],

  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        cli: resolve(__dirname, 'src/cli.ts'),
        // Phase 0 feasibility spike (plans/personal_assistant_cli_pinned_input_plan.html) —
        // temporary entry, removed along with src/tui-spike.tsx once Phase 5 confirms Ink
        // works over a real live terminal.
        spike: resolve(__dirname, 'src/tui-spike.tsx'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@buildaharness/harness', '@buildaharness/runtime', 'ink', 'nodemailer', 'react', 'react/jsx-runtime', 'node:readline', 'node:process', 'node:fs', 'node:fs/promises', 'node:os', 'node:path', 'node:child_process', 'node:url', 'node:dns/promises', 'node:crypto', 'node:net', 'node:stream', 'node:util'],
    },
    minify: false,
    sourcemap: true,
  },
})
