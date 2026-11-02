/**
 * Where the mail feed is fetched from. In production (no MAILFEED_BASE_URL) it
 * goes over the EDGE binding: a plain fetch from this worker to hadoku.me lands
 * on the origin and answers 404, which is how every scheduled reconcile failed
 * on 2026-11-02 (hadoku-jobplatform#25). An explicit MAILFEED_BASE_URL is
 * fetched directly, which is what the route tests' loopback feed relies on.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Fetcher } from '@cloudflare/workers-types';
import { fetchScope } from '../src/clients/mailfeed.ts';
import type { AppEnv } from '../src/types.ts';

const SCOPE = { success: true, data: { label: 'ats', senderDomains: ['greenhouse-mail.io'] } };
const json = (body: unknown) =>
	new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe('the mail feed client', () => {
	it('reaches the default feed over EDGE, with the service key, never a plain fetch', async () => {
		const seen: { url: string; key: string | null }[] = [];
		globalThis.fetch = (async () => {
			throw new Error('a plain fetch would land on the origin');
		}) as typeof fetch;
		const edge = {
			fetch: async (url: string, init?: RequestInit) => {
				seen.push({ url, key: new Headers(init?.headers).get('X-User-Key') });
				return json(SCOPE);
			},
		} as unknown as Fetcher;
		const env = { HADOKU_SERVICE_KEY: 'svc', EDGE: edge } as unknown as AppEnv;
		assert.deepEqual(await fetchScope(env), SCOPE.data);
		assert.deepEqual(seen, [{ url: 'https://hadoku.me/contact/api/mailfeed/scope', key: 'svc' }]);
	});

	it('fetches an explicit MAILFEED_BASE_URL directly', async () => {
		const urls: string[] = [];
		globalThis.fetch = (async (url: string) => {
			urls.push(url);
			return json(SCOPE);
		}) as typeof fetch;
		const env = {
			HADOKU_SERVICE_KEY: 'svc',
			MAILFEED_BASE_URL: 'http://127.0.0.1:9/feed',
		} as unknown as AppEnv;
		assert.deepEqual(await fetchScope(env), SCOPE.data);
		assert.deepEqual(urls, ['http://127.0.0.1:9/feed/scope']);
	});

	it('says so when EDGE is not bound, rather than falling back to a fetch that 404s', async () => {
		const env = { HADOKU_SERVICE_KEY: 'svc' } as unknown as AppEnv;
		const got = await fetchScope(env);
		assert.match(String((got as { error: string }).error), /EDGE service binding not configured/);
	});
});
