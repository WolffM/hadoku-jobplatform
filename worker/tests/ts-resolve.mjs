// Worker source imports siblings with a `.js` specifier (the bundler/ESM
// convention vite and tsc expect). Node strips types natively but won't remap
// `.js` → `.ts`, so tests importing anything past a leaf module fail to
// resolve. This hook does that one rewrite and nothing else.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
	if (specifier.startsWith('.') && specifier.endsWith('.js')) {
		const asTs = specifier.slice(0, -3) + '.ts';
		try {
			const resolved = await next(asTs, context);
			if (existsSync(fileURLToPath(resolved.url))) return resolved;
		} catch {
			// No sibling .ts — fall through to the real .js specifier below.
		}
	}
	return next(specifier, context);
}
