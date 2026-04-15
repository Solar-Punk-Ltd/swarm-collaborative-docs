import * as path from 'path'
import { fileURLToPath } from 'url'

import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig } from 'eslint/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const compat = await import(`${__dirname}/eslint-compat.cjs`)
const js = compat.default.js
const ts = compat.default.ts
const tsParser = compat.default.tsParser
const prettier = compat.default.prettier
const importPlugin = compat.default.importPlugin
const prettierPlugin = compat.default.prettierPlugin
const simpleImportSort = compat.default.simpleImportSort
const react = compat.default.react

const eslintRecommended = js.configs.recommended

const typescriptRecommended = {
  plugins: {
    '@typescript-eslint': ts,
  },
  rules: {
    ...ts.configs.recommended.rules,
  },
}

const importRules = {
  plugins: {
    import: importPlugin,
  },
  rules: {
    ...importPlugin.configs.errors.rules,
    ...importPlugin.configs.warnings.rules,
    ...importPlugin.configs.typescript.rules,
  },
}

const prettierRecommended = {
  plugins: {
    prettier: prettierPlugin,
  },
  rules: {
    'prettier/prettier': 'error',
    ...prettier.rules,
  },
}

export default defineConfig([
  reactHooks.configs.flat.recommended,
  {
    ignores: [
      '**/node_modules/**',
      'eslint.config.mjs',
      'eslint-compat.cjs',
      '**/assets/**',
      'dist/**',
      'commitlint.config.cjs',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          tsConfigRootDir: __dirname,
        },
      },
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
      globals: {
        document: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly',
        navigator: 'readonly',
        crypto: 'readonly',
        AbortController: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        BroadcastChannel: 'readonly',
        MessageEvent: 'readonly',
        RTCIceServer: 'readonly',
        RTCPeerConnection: 'readonly',
        RTCDataChannelEvent: 'readonly',
        RTCDataChannel: 'readonly',
        RTCPeerConnectionIceErrorEvent: 'readonly',
        localStorage: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLElement: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        CustomEvent: 'readonly',
      },
    },
  },
  eslintRecommended,
  typescriptRecommended,
  importRules,
  prettierRecommended,
  prettier,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    plugins: {
      '@typescript-eslint': ts,
      'simple-import-sort': simpleImportSort,
      react: react,
    },
    rules: {
      'array-bracket-newline': ['error', 'consistent'],
      strict: ['error', 'safe'],
      'block-scoped-var': 'error',
      complexity: 'warn',
      'default-case': 'error',
      'dot-notation': 'warn',
      eqeqeq: 'error',
      'guard-for-in': 'warn',
      'linebreak-style': ['warn', 'unix'],
      'no-alert': 'error',
      'no-case-declarations': 'error',
      // 'no-console': 'error',
      'no-constant-condition': 'error',
      'no-continue': 'warn',
      'no-div-regex': 'error',
      'no-empty': 'warn',
      'no-empty-pattern': 'error',
      'no-implicit-coercion': 'error',
      'prefer-arrow-callback': 'warn',
      'no-labels': 'error',
      'no-loop-func': 'error',
      'no-nested-ternary': 'warn',
      'no-script-url': 'error',
      'quote-props': ['error', 'as-needed'],
      'require-yield': 'error',
      'max-depth': ['error', 4],
      'require-await': 'warn',
      'space-before-function-paren': [
        'error',
        {
          anonymous: 'never',
          named: 'never',
          asyncArrow: 'always',
        },
      ],
      'padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: 'if' },
        { blankLine: 'always', prev: '*', next: 'function' },
        { blankLine: 'always', prev: '*', next: 'return' },
      ],
      'no-useless-constructor': 'off',
      'no-dupe-class-members': 'off',
      'no-unused-expressions': 'off',
      'no-unused-vars': 'off',
      curly: ['error', 'multi-line'],
      'object-curly-spacing': ['error', 'always'],
      'comma-dangle': ['error', 'always-multiline'],
      'react-hooks/set-state-in-effect': 'off',
      '@typescript-eslint/no-useless-constructor': 'error',
      '@typescript-eslint/no-unused-expressions': 'error',
      '@typescript-eslint/no-dupe-class-members': 'error',
      'react/react-in-jsx-scope': 'off',
      'max-nested-callbacks': ['error', 4],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            ['^@?\\w'], // Packages
            ['^\\u0000'], // Side effect imports
            ['^\\.\\.(?!/?$)', '^\\.\\./?$'], // Parent imports
            ['^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$'], // Other relative imports
            ['^.+\\.?(css)$'], // Style imports
          ],
        },
      ],
    },
  },
])
