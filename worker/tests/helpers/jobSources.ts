import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sources');

/**
 * A recorded response from a real source, saved once on 2026-11-27 and trimmed
 * (fewer results, shorter description text; structure and field values as
 * the source sent them).
 */
export function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), 'utf8');
}

export function fixtureJson<T = Record<string, unknown>>(name: string): T {
	return JSON.parse(fixture(name)) as T;
}

export interface SourceCall {
	path: string;
	query: URLSearchParams;
	headers: Record<string, string | undefined>;
}

export interface Reply {
	status: number;
	body: string;
	type?: string;
}

/**
 * A loopback stand-in for every pulled source at once, laid out the way
 * JOB_SOURCES_BASE_URL routes them (`/<source>/<the source's own path>`).
 * Answers from the recorded fixtures by default; `override` replaces the
 * answer for one path (status, body). Records every request.
 */
export async function startJobSources(): Promise<{
	url: string;
	calls: SourceCall[];
	override(path: string, reply: Reply | ((call: SourceCall) => Reply)): void;
	reset(): void;
	stop(): Promise<void>;
}> {
	const calls: SourceCall[] = [];
	const overrides = new Map<string, Reply | ((call: SourceCall) => Reply)>();

	function defaultReply(path: string): Reply {
		if (path === '/arbeitsagentur/pc/v6/jobs') {
			return { status: 200, body: fixture('arbeitsagentur-search.json') };
		}
		if (path.startsWith('/arbeitsagentur/pc/v4/jobdetails/')) {
			const ref = Buffer.from(decodeURIComponent(path.split('/').pop() ?? ''), 'base64').toString();
			const detail = fixtureJson('arbeitsagentur-detail.json');
			// One recorded detail stands in for every posting: same text,
			// the requested reference number.
			return { status: 200, body: JSON.stringify({ ...detail, referenznummer: ref }) };
		}
		const personio = /^\/personio\/([^/]+)\/xml$/.exec(path);
		if (personio) {
			return { status: 200, body: fixture('personio-feed.xml'), type: 'application/xml' };
		}
		if (/^\/smartrecruiters\/v1\/companies\/[^/]+\/postings$/.test(path)) {
			return { status: 200, body: fixture('smartrecruiters-postings.json') };
		}
		if (/^\/smartrecruiters\/v1\/companies\/[^/]+\/postings\/[^/]+$/.test(path)) {
			return { status: 200, body: fixture('smartrecruiters-posting.json') };
		}
		return { status: 404, body: '{"message":"not found"}' };
	}

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const u = new URL(req.url ?? '/', 'http://loopback');
		const call: SourceCall = {
			path: u.pathname,
			query: u.searchParams,
			headers: {
				'x-api-key': req.headers['x-api-key'] as string | undefined,
				'user-agent': req.headers['user-agent'] as string | undefined,
			},
		};
		calls.push(call);
		const o = overrides.get(u.pathname);
		const reply = o ? (typeof o === 'function' ? o(call) : o) : defaultReply(u.pathname);
		res.writeHead(reply.status, { 'Content-Type': reply.type ?? 'application/json' });
		res.end(reply.body);
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		calls,
		override: (path, reply) => overrides.set(path, reply),
		reset: () => {
			calls.length = 0;
			overrides.clear();
		},
		stop: () => new Promise<void>((r) => server.close(() => r())),
	};
}
