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
				project: ['./tsconfig.json'],
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
		ignores: ['dist/**', 'node_modules/**', '*.config.js', '*.config.ts', 'validate-template.mjs'],
	},
];
