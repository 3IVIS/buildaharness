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

  resolve: {
    alias: {
      '@itsharness/canvas': resolve(__dirname, '../canvas/src/spec/schema.ts'),
    },
  },

  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    minify: false,
    sourcemap: true,
  },
})
