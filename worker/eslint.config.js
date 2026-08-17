import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';

export default [
	js.configs.recommended,
	prettierConfig,
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: 'latest',
				sourceType: 'module',
				project: ['./tsconfig.json', './tsconfig.test.json'],
			},
			globals: {
				console: 'readonly',
				Date: 'readonly',
				Map: 'readonly',
				Set: 'readonly',
				Promise: 'readonly',
				fetch: 'readonly',
				Request: 'readonly',
				Response: 'readonly',
				URL: 'readonly',
				URLSearchParams: 'readonly',
				Headers: 'readonly',
				TextEncoder: 'readonly',
				AbortController: 'readonly',
				AbortSignal: 'readonly',
				crypto: 'readonly',
			},
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
		},
		rules: {
			...tsPlugin.configs.recommended.rules,
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
				},
			],
			'@typescript-eslint/explicit-function-return-type': 'off',
			'@typescript-eslint/no-explicit-any': 'warn',
			'no-console': 'off',
		},
	},
	{
		// Tests run on node, not in the Workers runtime, so they legitimately reach
		// for globals the list above deliberately withholds from src/ (Buffer for
		// the loopback resume-api server, RequestInit for the node fetch types).
		// Scoped to tests/ so worker source still can't reach a global that does
		// not exist at the edge.
		files: ['tests/**/*.ts'],
		languageOptions: {
			globals: {
				Buffer: 'readonly',
				RequestInit: 'readonly',
				process: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
			},
		},
	},
	{
		ignores: ['dist/**', 'node_modules/**', '*.config.js', '*.config.ts', 'validate-template.mjs'],
	},
];
