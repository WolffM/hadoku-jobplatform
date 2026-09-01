import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import globals from 'globals'
import prettierConfig from 'eslint-config-prettier'

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      // Local perf harness (worker/bench, gitignored): a wrangler entry that
      // binds the real remote D1 so feed timings can be measured without a
      // deploy. It belongs to no tsconfig, so the typed rules cannot parse it.
      'worker/bench/**',
      // Agent worktrees live here (see AGENTS.md). They are full checkouts, so
      // without this the MAIN checkout lints every worktree's sources against
      // its own tsconfig and fails with "file not found in any of the provided
      // project(s)" — which blocks commits here for as long as a worktree exists.
      '.claude/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      'tests/**', // Playwright e2e — outside the src/ TS project
      // Worker integration tests + their helpers. Same reason: they belong to
      // worker/tsconfig.test.json, which is not in `project` below, and they
      // are already linted by worker/eslint.config.js.
      'worker/tests/**',
      '**/vite.config.ts',
      'playwright.config.ts'
    ]
  },

  // -------------------------------------------------------------
  // Base TypeScript + React config
  // -------------------------------------------------------------
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: ['./tsconfig.json', './worker/tsconfig.json']
      },
      globals: {
        // Sanitize keys to fix globals.browser bug (trailing whitespace in "AudioWorkletGlobalScope ")
        ...Object.fromEntries(
          Object.entries(globals.browser).map(([key, value]) => [key.trim(), value])
        )
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {
      // Pull in all recommended + strict TS rules
      ...js.configs.recommended.rules,
      ...tsPlugin.configs['recommended'].rules,
      ...tsPlugin.configs['recommended-type-checked'].rules,
      ...tsPlugin.configs['stylistic-type-checked'].rules,

      // -----------------------------
      //     SENSIBLE STRICT RULES
      // -----------------------------

      // Prevent sloppy code paths
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // Avoid silent bugs
      '@typescript-eslint/no-unnecessary-condition': 'off', // Allow defensive null checks
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],

      // Real-world strictness
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': ['warn', { fixToUnknown: false }],
      '@typescript-eslint/no-non-null-assertion': 'off', // Allow ! after validation checks

      // Browser correctness
      'no-restricted-globals': ['error', 'event', 'fdescribe'],

      // Safer equality
      eqeqeq: ['error', 'always'],

      // Clean imports
      'no-unused-vars': 'off',
      'no-duplicate-imports': 'error',
      'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],

      // Allow void for fire-and-forget async (cleaner than .catch(() => {}))
      'no-void': 'off',

      // Allow console logs when intentional
      'no-console': 'off',

      // Allow intentional || for empty strings and falsy values
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/prefer-optional-chain': 'off'
    }
  },

  // -------------------------------------------------------------
  // PRETTIER OVERRIDES (must be last)
  // -------------------------------------------------------------
  prettierConfig
]
