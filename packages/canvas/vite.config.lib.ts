import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import dts from 'vite-plugin-dts'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    react(),
    // Emit .d.ts alongside the JS output so consumers get full types.
    dts({
      include: ['src'],
      insertTypesEntry: true,
      // vite-plugin-dts v4: use tsconfigPath instead of tsConfigFilePath
      tsconfigPath: resolve(__dirname, 'tsconfig.build.json'),
    }),
  ],

  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'ItsHarnessCanvas',
      // vite generates both ESM (.js) and CJS (.cjs) from these formats.
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'index.js' : 'index.cjs'),
    },

    // Keep peer deps out of the bundle — consumers provide them.
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime', '@xyflow/react'],
      output: {
        // Put CSS assets where package.json exports expects them.
        assetFileNames: (assetInfo) =>
          assetInfo.names?.includes('index.css') ? 'styles.css' : (assetInfo.name ?? 'asset'),
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          '@xyflow/react': 'XYFlow',
        },
      },
    },

    // Avoid mangling — consumers need legible stack traces.
    minify: false,
    sourcemap: true,
  },
})
