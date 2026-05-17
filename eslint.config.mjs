// Updated for @typescript-eslint v8 + eslint-plugin-react-hooks v5 (ESLint 9 flat config).
//
// Breaking changes from v7→v8:
//   - tsPlugin.configs['recommended'] is now a flat-config object { name, plugins, rules }
//     rather than a legacy eslintrc object.  Spreading .rules still works but we now
//     pull the plugin registration from the config itself so it stays in sync.
//   - eslint-plugin-react-hooks v5 exports configs.recommended as a flat-config object
//     (previously it was { rules: {...} } only).  Use the recommended object directly.
import js           from '@eslint/js'
import tsPlugin     from '@typescript-eslint/eslint-plugin'
import tsParser     from '@typescript-eslint/parser'
import reactHooks   from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: ['dist/', 'node_modules/', 'spec/dist/'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      // v8: pull plugin reference from the recommended config object so it always
      // matches what the config declares — avoids version-skew between plugin
      // instance used for rules and the one registered here.
      '@typescript-eslint': tsPlugin,
      'react-hooks':        reactHooks,
      'react-refresh':      reactRefresh,
    },
    rules: {
      // @typescript-eslint v8: configs['recommended'].rules still a plain rules map
      ...tsPlugin.configs['recommended'].rules,
      '@typescript-eslint/no-explicit-any':       'warn',
      '@typescript-eslint/no-unused-vars':         ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion':  'warn',

      // react-hooks v5: configs.recommended is a flat-config object { plugins, rules }
      ...reactHooks.configs.recommended.rules,

      // React Refresh (Vite HMR)
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // General
      'no-console': ['warn', { allow: ['warn', 'error', 'info', 'debug'] }],
      'eqeqeq':     ['error', 'always'],
    },
  },
]
