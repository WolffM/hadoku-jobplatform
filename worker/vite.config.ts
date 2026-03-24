import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
	plugins: [
		dts({
			rollupTypes: true,
			outDir: 'dist',
		}),
	],
	build: {
		lib: {
			entry: 'src/index.ts',
			formats: ['es'],
			fileName: () => 'index.js',
		},
		rollupOptions: {
			// Externalize peer dependencies (host worker provides them)
			external: ['hono', 'hono/cors', '@hono/zod-openapi', '@wolffm/worker-utils'],
		},
		target: 'es2022',
		minify: false, // Keep readable for debugging
	},
});
