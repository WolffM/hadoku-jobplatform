/**
 * Integration harness — a real worker environment, not a stubbed one.
 *
 * Three things every route test needs, all of them genuine:
 *
 *   D1      Miniflare boots workerd and hands back the same `D1Database`
 *           implementation the deployed worker talks to. Every migration in
 *           `worker/migrations/` is applied in order, so tests query the real
 *           schema and real SQLite (json1, ON CONFLICT, DROP COLUMN and all).
 *
 *   Auth    `createEdgeAuth()` reads plain headers — X-Edge-Auth against
 *           EDGE_AUTH_SECRET, then X-Hadoku-Tier and X-User-Id. Tests send
 *           those headers, so requests run through the real middleware and a
 *           wrong secret really does degrade to `public`. Nothing is injected
 *           past the gate.
 *
 *   RESUME  resume-api is a separately deployed worker we cannot reach from a
 *           test, so `startResumeService()` runs a real node:http server and
 *           binds it as the `Fetcher`. The calls leave the process over HTTP
 *           and come back as real Responses; only the far-side implementation
 *           is ours. It records what it received so tests can assert on the
 *           payload the binding actually sent.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database, Fetcher } from '@cloudflare/workers-types';
import { createJobPlatformHandler } from '../../src/index.js';
import type { AppEnv } from '../../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'migrations');

export const BASE = '/jobplatform/api';
export const EDGE_SECRET = 'test-edge-secret';

/**
 * Split a migration file into statements.
 *
 * D1's `exec()` is line-oriented and chokes on the multi-line UPDATE ... CASE
 * in 0009, so we hand it one statement at a time. Semicolons inside string
 * literals (0009's json path arguments) must not split, hence the quote-aware
 * scan rather than `sql.split(';')`.
 */
function splitStatements(sql: string): string[] {
	const stripped = sql.replace(/^\s*--.*$/gm, '');
	const out: string[] = [];
	let buf = '';
	let inString = false;
	for (const ch of stripped) {
		if (ch === "'") inString = !inString;
		if (ch === ';' && !inString) {
			if (buf.trim()) out.push(buf.trim());
			buf = '';
			continue;
		}
		buf += ch;
	}
	if (buf.trim()) out.push(buf.trim());
	return out;
}

async function applyMigrations(db: D1Database): Promise<void> {
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	for (const file of files) {
		const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
		for (const stmt of splitStatements(sql)) {
			try {
				await db.prepare(stmt).run();
			} catch (err) {
				throw new Error(`migration ${file} failed on:\n${stmt}\n\n${String(err)}`);
			}
		}
	}
}

// ============================================================================
// resume-api stand-in — a real HTTP server behind a real Fetcher
// ============================================================================

export interface ResumeCall {
	path: string;
	body: Record<string, unknown>;
	headers: Record<string, string | undefined>;
}

export interface ResumeService {
	binding: Fetcher;
	/** Every request the binding delivered, in order. */
	calls: ResumeCall[];
	/** Reply to subsequent call(s) with this status/body instead of the default. */
	respondWith(status: number, body: unknown): void;
	/** Forget recorded calls and drop any respondWith override. */
	reset(): void;
	stop(): Promise<void>;
}

/** Default payloads, keyed by the resume-api path the worker proxies to. */
const DEFAULT_REPLIES: Record<string, unknown> = {
	'/resume/api/tailored-resume': {
		resume_markdown: '# Test Resume',
		blocks_used: ['summary', 'experience'],
		cached: false,
	},
	'/resume/api/cover-letter': {
		cover_letter_markdown: '# Test Cover Letter',
		cached: false,
	},
	'/resume/api/application-extras': {
		intro_email: 'Hello.',
		screening_answers: [],
	},
	'/resume/api/variants': { slug: 'abc123' },
	// Reading a minted variant back. `variant` present = the slug still resolves;
	// resume-api omits it (and serves the canonical résumé) once one has expired.
	'/resume/api/resume': { content: '# Minted Resume', variant: 'abc123' },
};

export async function startResumeService(): Promise<ResumeService> {
	const calls: ResumeCall[] = [];
	let override: { status: number; body: unknown } | null = null;

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			const path = (req.url ?? '/').split('?')[0];
			const raw = Buffer.concat(chunks).toString('utf8');
			let body: Record<string, unknown> = {};
			try {
				body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
			} catch {
				body = { __unparsed: raw };
			}
			calls.push({
				path,
				body,
				headers: {
					'x-edge-auth': req.headers['x-edge-auth'] as string | undefined,
					'x-hadoku-tier': req.headers['x-hadoku-tier'] as string | undefined,
					'content-type': req.headers['content-type'] as string | undefined,
				},
			});

			if (override) {
				const { status, body: b } = override;
				res.writeHead(status, { 'Content-Type': 'application/json' });
				res.end(typeof b === 'string' ? b : JSON.stringify(b));
				return;
			}
			const reply = DEFAULT_REPLIES[path];
			if (reply === undefined) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: `no stand-in route for ${path}` }));
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(reply));
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;

	// The worker calls `https://resume-api{path}`; a service binding never
	// resolves DNS, so rewriting the origin to the loopback server is exactly
	// what the platform does — the path, method, headers and body are untouched.
	const binding = {
		fetch: (input: string | Request, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input.url;
			const rewritten = new URL(url);
			rewritten.protocol = 'http:';
			rewritten.host = `127.0.0.1:${port}`;
			return fetch(rewritten.toString(), init as RequestInit);
		},
	} as unknown as Fetcher;

	return {
		binding,
		calls,
		respondWith(status: number, body: unknown) {
			override = { status, body };
		},
		reset() {
			calls.length = 0;
			override = null;
		},
		async stop() {
			await new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve()))
			);
		},
	};
}

// ============================================================================
// The harness itself
// ============================================================================

export interface Harness {
	/** Send a request through the real handler; returns the real Response. */
	fetch(path: string, init?: RequestInit & { tier?: string; userId?: string }): Promise<Response>;
	/** Same, parsed as JSON alongside the status. */
	json<T = unknown>(
		path: string,
		init?: RequestInit & { tier?: string; userId?: string }
	): Promise<{ status: number; body: T }>;
	db: D1Database;
	resume: ResumeService;
	/**
	 * Await everything the worker handed to waitUntil, returning how many there
	 * were — so a test can assert work was BACKGROUNDED, not merely that it
	 * happened. On Workers an unattached promise is killed with the response, so
	 * that distinction decides whether it runs in production at all.
	 */
	settle(): Promise<number>;
	dispose(): Promise<void>;
}

/**
 * A fake edge-router that resolves exactly one name.
 *
 * `Hadoku` resolves; `Ghost` is a live row that never signed in (no userId);
 * anything else is unknown. Those three are the three outcomes the route has to
 * report differently, and a fake that only ever succeeds would let all three
 * collapse into one status without any test noticing.
 */
export function defaultEdge(): Fetcher {
	return {
		async fetch(input: Request | string | URL): Promise<Response> {
			// `.url`, not `.toString()`: the resolver passes a Request, and
			// stringifying one yields "[object Request]". Getting this wrong made
			// every call look like an unreachable resolver, which is the failure
			// mode this fake exists to tell apart from the others.
			const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const name = (new URL(raw).searchParams.get('name') ?? '').toLowerCase();
			if (name === 'hadoku') {
				return Response.json({ userId: 'user-hadoku', name: 'Hadoku', tier: 'admin' });
			}
			if (name === 'ghost') {
				// A live row that never signed in. The endpoint reports this as a
				// 409 with NO_USER_ID — a 200 carrying `userId: null` would be
				// read as an unreachable resolver instead.
				return Response.json(
					{ error: 'That name has never signed in.', code: 'NO_USER_ID' },
					{ status: 409 }
				);
			}
			return Response.json(
				{ error: `No registered key named "${name}".`, code: 'NAME_NOT_FOUND' },
				{ status: 404 }
			);
		},
	} as unknown as Fetcher;
}

export interface HarnessOptions {
	/**
	 * Override the edge binding. `null` leaves it UNBOUND, which is the
	 * deployment fault the route must report as retryable rather than as
	 * "no such user".
	 */
	edge?: Fetcher | null;
	/**
	 * Leave `env.RESUME` unset, as it is in a deployment where the service
	 * binding was never declared. The tailoring routes must fail loudly there.
	 */
	withoutResumeBinding?: boolean;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const mf = new Miniflare({
		modules: true,
		// The worker under test runs in-process against the bindings below; this
		// script exists only because Miniflare requires one to allocate them.
		script: 'export default { fetch: () => new Response("unused") };',
		d1Databases: { JOB_PLATFORM_DB: `db-${Math.random().toString(36).slice(2)}` },
	});
	const db = (await mf.getD1Database('JOB_PLATFORM_DB')) as unknown as D1Database;
	await applyMigrations(db);

	const resume = await startResumeService();

	const env: AppEnv = {
		EDGE_AUTH_SECRET: EDGE_SECRET,
		JOB_PLATFORM_DB: db,
		SCRAPER_USER_KEY: 'test-service-key',
		// Loopback to a closed port, so the suite cannot call the real scraper.
		// It could not before, for the wrong reason: triggerSearchBg's work went to
		// an ExecutionContext the harness did not pass, so it never ran. Now that it
		// does, leaving this unset would mean every profile write in these tests
		// POSTs to production. The call is fire-and-forget and its failure is
		// logged, so a refused connection is the honest local answer.
		SCRAPER_BASE_URL: 'http://127.0.0.1:1',
		...(options.withoutResumeBinding ? {} : { RESUME: resume.binding }),
		// Stand-in for the edge-router service binding. Name resolution is the
		// one thing it is asked for, so the fake answers exactly that and
		// nothing else — including the failure shapes, which carry different
		// meanings the route has to keep apart.
		...(options.edge === null ? {} : { EDGE: options.edge ?? defaultEdge() }),
	};

	const app = createJobPlatformHandler(BASE);

	/** Promises the worker handed to waitUntil, drained by settle(). */
	const pending: Promise<unknown>[] = [];

	function request(
		path: string,
		init: RequestInit & { tier?: string; userId?: string } = {}
	): Promise<Response> {
		const { tier, userId, headers, ...rest } = init;
		const h = new Headers(headers);
		// A tier is only trusted alongside a matching X-Edge-Auth — send both, so
		// the request clears the same gate a real edge-forwarded one does.
		if (tier) {
			h.set('X-Edge-Auth', EDGE_SECRET);
			h.set('X-Hadoku-Tier', tier);
			h.set('X-User-Key', 'test-credential');
			h.set('X-User-Id', userId ?? 'user-one');
		}
		if (rest.body && !h.has('Content-Type')) h.set('Content-Type', 'application/json');
		// Pass an ExecutionContext, like the runtime does. Omitting it made every
		// `c.executionCtx?.waitUntil()` throw, and the background work behind it
		// ran unattached — which still COMPLETES under node, so a test could pass
		// while the same code did nothing on Workers (where an unattached promise
		// is killed with the response). Collecting the promises here is what makes
		// `settle()` able to assert the work was actually handed to waitUntil.
		return app.fetch(
			new Request(`https://hadoku.me${path}`, { ...rest, headers: h }),
			env as unknown as Record<string, unknown>,
			{
				waitUntil: (p: Promise<unknown>) => {
					pending.push(p);
				},
				passThroughOnException: () => {},
			} as unknown as ExecutionContext
		) as unknown as Promise<Response>;
	}

	return {
		fetch: request,
		/**
		 * Await everything handed to waitUntil so far.
		 *
		 * Returns how many there were, so a test can assert the work was
		 * BACKGROUNDED rather than merely having happened — the distinction that
		 * decides whether it runs at all in production.
		 */
		async settle() {
			const n = pending.length;
			await Promise.allSettled(pending.splice(0));
			return n;
		},
		async json<T = unknown>(path: string, init?: RequestInit & { tier?: string; userId?: string }) {
			const res = await request(path, init);
			return { status: res.status, body: (await res.json()) as T };
		},
		db,
		resume,
		async dispose() {
			// Let anything still in waitUntil finish against a live database.
			// Disposing Miniflare first poisons the D1 stub underneath it, so a
			// background rank build outliving its test logged a confusing failure
			// that had nothing to do with the code under test.
			await Promise.allSettled(pending.splice(0));
			await resume.stop();
			await mf.dispose();
		},
	};
}
