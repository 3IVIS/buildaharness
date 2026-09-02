import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    dts({
      include: ['src'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      // Pin the declaration root to this package's own src/ — the
      // @buildaharness/harness source alias below otherwise drags the dts
      // plugin's computed entryRoot up to packages/, emitting a broken
      // `export * from './runtime/src/index'` stub as dist/index.d.ts.
      entryRoot: resolve(__dirname, 'src'),
      insertTypesEntry: true,
      tsconfigPath: resolve(__dirname, 'tsconfig.json'),
    }),
  ],

  resolve: {
    alias: {
      '@buildaharness/harness': resolve(__dirname, '../harness/src/index.ts'),
    },
  },

  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    // Keep @buildaharness/harness a real runtime dependency rather than bundling
    // a second copy into this package's dist (class identity / instanceof would
    // break against a consumer that also imports @buildaharness/harness).
    rollupOptions: {
      external: [/^@buildaharness\//],
    },
    minify: false,
    sourcemap: true,
  },
})
