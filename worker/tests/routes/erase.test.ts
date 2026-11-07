/**
 * POST /_account/erase — the account-erase hook (routes/account.ts).
 *
 * Three properties the edge depends on: it deletes the person's own rows and
 * nobody else's, a second call answers zeros (the edge calls it twice), and a
 * request without the edge's seal is refused rather than erasing anyone. Plus a
 * schema guard: a new per-person table must be added to the erase, or it would
 * outlive the account with nothing to say so.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, EDGE_SECRET, type Harness } from '../helpers/harness.ts';
import { seedJob, seedJobState } from '../helpers/seed.ts';
import { ERASED_TABLES } from '../../src/routes/account.ts';

const BASE = '/jobplatform/api';
const PATH = `${BASE}/_account/erase`;
const GONE = 'user-gone';
const KEPT = 'user-kept';

let h: Harness;

type EraseBody = { success: boolean; erased?: Record<string, number>; error?: string };

/** The request exactly as edge-router's eraseMemberData sends it. */
function eraseAsEdge(userId: string, secret = EDGE_SECRET) {
	return h.json<EraseBody>(PATH, {
		method: 'POST',
		headers: { 'X-Edge-Auth': secret, 'X-Hadoku-Tier': 'member', 'X-User-Id': userId },
	});
}

async function count(table: string, userId: string): Promise<number> {
	const sql =
		table === 'profile_companies' ||
		table === 'job_profile_rank' ||
		table === 'job_profile_rank_state'
			? `SELECT COUNT(*) AS n FROM ${table} WHERE profile_id IN (SELECT id FROM profiles WHERE user_id = ?)`
			: `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`;
	const row = await h.db.prepare(sql).bind(userId).first<{ n: number }>();
	return row?.n ?? 0;
}

/** One row in every per-person table for `userId`, two where a table allows it. */
async function seedPerson(userId: string): Promise<void> {
	const now = new Date().toISOString();
	const jobA = `job-a-${userId}`;
	const jobB = `job-b-${userId}`;
	await seedJob(h.db, { id: jobA });
	await seedJob(h.db, { id: jobB });
	const run = (sql: string, ...args: unknown[]) =>
		h.db
			.prepare(sql)
			.bind(...args)
			.run();
	const profile = `profile-${userId}`;
	await run(
		`INSERT INTO profiles (id, user_id, name, keywords, target_companies, track, levels, remote_pref, created_at)
		 VALUES (?, ?, 'Mine', '[]', '[]', 'either', '[]', 'any', ?)`,
		profile,
		userId,
		now
	);
	await run(
		`INSERT INTO profile_companies (id, profile_id, ats, slug, display_name, added_at)
		 VALUES (?, ?, 'greenhouse', 'acme', 'Acme', ?)`,
		`pc-${userId}`,
		profile,
		now
	);
	await run(
		'INSERT INTO job_profile_rank (profile_id, job_id, bound) VALUES (?, ?, 0.5), (?, ?, 0.4)',
		profile,
		jobA,
		profile,
		jobB
	);
	await run(
		`INSERT INTO job_profile_rank_state (profile_id, criteria_hash, max_job_rowid, built_at)
		 VALUES (?, 'h', 2, ?)`,
		profile,
		now
	);
	await run(
		"INSERT INTO profile_tombstones (user_id, profile_key, created_at) VALUES (?, 'default', ?)",
		userId,
		now
	);
	await seedJobState(h.db, { job_id: jobA, user_id: userId, state: 'applied' });
	await seedJobState(h.db, { job_id: jobB, user_id: userId, state: 'dismissed' });
	await run(
		"INSERT INTO blocked_companies (user_id, company_key, company, created_at) VALUES (?, 'globex', 'Globex', ?)",
		userId,
		now
	);
	await run(
		`INSERT INTO job_events (job_id, user_id, kind, from_state, to_state, note, occurred_at, created_at)
		 VALUES (?, ?, 'state', NULL, 'applied', NULL, ?, ?)`,
		jobA,
		userId,
		now,
		now
	);
	await run(
		`INSERT INTO job_feedback (id, user_id, job_id, vote, reason, created_at)
		 VALUES (?, ?, ?, 1, 'stack', ?)`,
		`fb-${userId}`,
		userId,
		jobA,
		now
	);
	await run(
		`INSERT INTO applications (id, user_id, job_id, variant_slug, mode, status, created_at, updated_at)
		 VALUES (?, ?, ?, 'packet', 'review', 'queued', ?, ?)`,
		`app-${userId}`,
		userId,
		jobA,
		now,
		now
	);
	await run(
		`INSERT INTO application_answers (user_id, question_key, question, answer, created_at, updated_at)
		 VALUES (?, 'gender', 'Gender', 'Decline', ?, ?)`,
		userId,
		now,
		now
	);
	await run(
		'INSERT INTO applicant_profiles (user_id, profile, updated_at) VALUES (?, ?, ?)',
		userId,
		'{"name":"Someone"}',
		now
	);
	await run(
		'INSERT INTO mail_reconcile_state (user_id, cursor, last_run_at) VALUES (?, NULL, ?)',
		userId,
		now
	);
	await run(
		`INSERT INTO mail_unmatched (user_id, message_id, received_at, from_domain, subject, kind, seen_at)
		 VALUES (?, ?, ?, 'ashby.io', 'Thanks for applying', 'confirmation', ?)`,
		userId,
		`msg-${userId}`,
		now,
		now
	);
	await run(
		`INSERT INTO owner_name_cache (name_key, user_id, name, tier, expires_at)
		 VALUES (?, ?, ?, 'friend', ?)`,
		userId.toLowerCase(),
		userId,
		`Name of ${userId}`,
		Date.now() + 60_000
	);
}

/** What seedPerson writes, per table. */
const SEEDED: Record<string, number> = {
	profile_companies: 1,
	job_profile_rank: 2,
	job_profile_rank_state: 1,
	profiles: 1,
	profile_tombstones: 1,
	job_states: 2,
	job_events: 1,
	job_feedback: 1,
	applications: 1,
	application_answers: 1,
	applicant_profiles: 1,
	mail_reconcile_state: 1,
	mail_unmatched: 1,
	blocked_companies: 1,
	owner_name_cache: 1,
};

const zeros = () => Object.fromEntries(Object.keys(SEEDED).map((t) => [t, 0]));

before(async () => {
	h = await createHarness();
});
after(async () => {
	await h.dispose();
});
beforeEach(async () => {
	// Children before parents: job_states and job_profile_rank reference jobs.
	for (const { table } of ERASED_TABLES) await h.db.prepare(`DELETE FROM ${table}`).run();
	await h.db.prepare('DELETE FROM jobs').run();
	await seedPerson(GONE);
	await seedPerson(KEPT);
});

describe('POST /_account/erase', () => {
	it("deletes the person's own rows in every table and counts each", async () => {
		const { status, body } = await eraseAsEdge(GONE);
		assert.equal(status, 200);
		assert.deepEqual(body.erased, SEEDED);
		for (const table of Object.keys(SEEDED)) {
			assert.equal(await count(table, GONE), 0, `${table} still holds the erased person`);
		}
	});

	it("leaves everyone else's rows, and the shared corpus, untouched", async () => {
		await eraseAsEdge(GONE);
		// The children are counted through KEPT's profile, which must survive too.
		for (const [table, n] of Object.entries(SEEDED)) {
			assert.equal(await count(table, KEPT), n, `${table} lost another person's rows`);
		}
		const jobs = await h.db.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>();
		assert.equal(jobs?.n, 4, 'postings name nobody and are not erased');
	});

	it('is idempotent: a second call answers zeros', async () => {
		await eraseAsEdge(GONE);
		const { status, body } = await eraseAsEdge(GONE);
		assert.equal(status, 200);
		assert.deepEqual(body.erased, zeros());
	});

	it('answers zeros for a person who never used the app', async () => {
		const { status, body } = await eraseAsEdge('user-never-here');
		assert.equal(status, 200);
		assert.deepEqual(body.erased, zeros());
	});

	it('refuses a request with no seal, and erases nothing', async () => {
		const { status, body } = await h.json<EraseBody>(PATH, {
			method: 'POST',
			headers: { 'X-Hadoku-Tier': 'member', 'X-User-Id': GONE },
		});
		assert.equal(status, 401);
		assert.equal(body.erased, undefined);
		assert.equal(await count('applications', GONE), 1);
	});

	it('refuses a wrong seal, and erases nothing', async () => {
		const { status, body } = await eraseAsEdge(GONE, 'not-the-secret');
		assert.equal(status, 401);
		assert.equal(body.erased, undefined);
		assert.equal(await count('profiles', GONE), 1);
	});

	it('refuses a sealed request that names nobody', async () => {
		const { status, body } = await h.json<EraseBody>(PATH, {
			method: 'POST',
			headers: { 'X-Edge-Auth': EDGE_SECRET, 'X-Hadoku-Tier': 'member' },
		});
		assert.equal(status, 401);
		assert.equal(body.erased, undefined);
	});

	it('takes the person from the edge-stamped header, never the body', async () => {
		const { status, body } = await h.json<EraseBody>(PATH, {
			method: 'POST',
			headers: { 'X-Edge-Auth': EDGE_SECRET, 'X-Hadoku-Tier': 'member', 'X-User-Id': GONE },
			body: JSON.stringify({ userId: KEPT }),
		});
		assert.equal(status, 200);
		assert.equal(body.erased?.applications, 1);
		assert.equal(await count('applications', KEPT), 1);
	});
});

describe('schema: every per-person table is erased', () => {
	it('each table with a user_id column, and each child of profiles, is in ERASED_TABLES', async () => {
		const tables = await h.db
			.prepare(
				"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
			)
			.all<{ name: string; sql: string }>();
		const perPerson = tables.results
			.filter((t) => /\b(user_id|profile_id)\b/.test(t.sql))
			.map((t) => t.name)
			.sort();
		assert.ok(perPerson.length > 0, 'expected per-person tables in the schema');
		assert.deepEqual(perPerson, ERASED_TABLES.map((t) => t.table).sort());
	});
});
