import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    dts({
      include: ['src'],
      insertTypesEntry: true,
      tsconfigPath: resolve(__dirname, 'tsconfig.json'),
    }),
  ],

  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        cli: resolve(__dirname, 'src/cli.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@buildaharness/harness', '@buildaharness/runtime', 'node:readline', 'node:process', 'node:fs/promises', 'node:os', 'node:path', 'node:child_process', 'node:url', 'node:dns/promises'],
    },
    minify: false,
    sourcemap: true,
  },
})
