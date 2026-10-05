/**
 * What a form-filler in the OWNER'S OWN BROWSER needs to fill one application.
 *
 * Every board we apply through refuses the runner's browser at submit:
 * Greenhouse holds the application for an emailed code, Ashby flags it as spam
 * (2026-10-03/04). So the owner fills and submits from their own Chrome with an
 * extension, and these routes give it the same material the runner had:
 *
 *   GET/PUT /applicant-profile    name, contact, links, education, work history
 *   GET /jobs/:id/fill-packet     that, plus what this application was filled
 *                                 with — the answers the owner APPROVED — and
 *                                 the tailored résumé to attach
 *
 * Replaying the approved answers is the point: the extension enters what the
 * owner already reviewed, not a fresh guess.
 */
import type { D1Database } from '@cloudflare/workers-types';
import { effectiveUserId, gateAuthed, isEffectiveUserError, type JobsApp } from './shared.js';
import { parseEvidence } from './applications.js';

/** Where resume-api renders a minted packet as a PDF (`?v=<slug>`). */
const RESUME_PDF_URL = 'https://hadoku.me/resume/api/resume.pdf';

function badRequest(message: string) {
	return { success: false as const, error: 'Bad request', message };
}

/** The runner's ApplicantProfile, checked only as far as a filler relies on it. */
function validProfile(p: unknown): p is Record<string, unknown> {
	if (typeof p !== 'object' || p === null || Array.isArray(p)) return false;
	const o = p as Record<string, unknown>;
	return typeof o.name === 'string' && !!o.name.trim() && typeof o.email === 'string';
}

async function loadProfile(db: D1Database, userId: string) {
	const row = await db
		.prepare('SELECT profile, updated_at FROM applicant_profiles WHERE user_id = ?')
		.bind(userId)
		.first<{ profile: string; updated_at: string }>();
	if (!row) return null;
	try {
		const parsed: unknown = JSON.parse(row.profile);
		return validProfile(parsed) ? { profile: parsed, updated_at: row.updated_at } : null;
	} catch {
		return null;
	}
}

export function registerFillRoutes(app: JobsApp) {
	app.get('/applicant-profile', gateAuthed);
	app.get('/applicant-profile', async (c) => {
		const who = await effectiveUserId(c, c.req.query('ownerName'));
		if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
		const found = await loadProfile(c.env.JOB_PLATFORM_DB, who.userId);
		return c.json(
			{
				success: true as const,
				data: { profile: found?.profile ?? null, updated_at: found?.updated_at ?? null },
			},
			200
		);
	});

	app.put('/applicant-profile', gateAuthed);
	app.put('/applicant-profile', async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json(badRequest('Body must be JSON'), 400);
		}
		const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
		if (!validProfile(b.profile)) {
			return c.json(badRequest('profile must be an object with a name and an email'), 400);
		}
		const who = await effectiveUserId(c, typeof b.ownerName === 'string' ? b.ownerName : undefined);
		if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
		const now = new Date().toISOString();
		await c.env.JOB_PLATFORM_DB.prepare(
			`INSERT INTO applicant_profiles (user_id, profile, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT (user_id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at`
		)
			.bind(who.userId, JSON.stringify(b.profile), now)
			.run();
		return c.json({ success: true as const, data: { updated_at: now } }, 200);
	});

	app.get('/jobs/:id/fill-packet', gateAuthed);
	app.get('/jobs/:id/fill-packet', async (c) => {
		const id = c.req.param('id');
		const who = await effectiveUserId(c, c.req.query('ownerName'));
		if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
		const db = c.env.JOB_PLATFORM_DB;

		const job = await db
			.prepare('SELECT id, company, title, url FROM jobs WHERE id = ?')
			.bind(id)
			.first<{ id: string; company: string; title: string; url: string }>();
		if (!job) {
			return c.json(
				{ success: false as const, error: 'Not found', message: `Job '${id}' not found` },
				404
			);
		}

		const app_ = await db
			.prepare(
				`SELECT id, status, variant_slug, evidence FROM applications
				 WHERE user_id = ? AND job_id = ?`
			)
			.bind(who.userId, id)
			.first<{ id: string; status: string; variant_slug: string; evidence: string | null }>();
		// Fall back to the packet stashed on the job state: a job can have a
		// minted packet before it has ever been queued.
		const state = await db
			.prepare('SELECT variant_slug FROM job_states WHERE user_id = ? AND job_id = ?')
			.bind(who.userId, id)
			.first<{ variant_slug: string | null }>();
		const slug = app_?.variant_slug || state?.variant_slug || '';

		const evidence = parseEvidence(app_?.evidence ?? null) ?? {};
		const answers =
			typeof evidence.answers === 'object' && evidence.answers !== null ? evidence.answers : {};
		const options =
			typeof evidence.options === 'object' && evidence.options !== null ? evidence.options : {};
		const multi = Array.isArray(evidence.multi) ? evidence.multi : [];

		const standing = await db
			.prepare('SELECT question, answer FROM application_answers WHERE user_id = ?')
			.bind(who.userId)
			.all<{ question: string; answer: string }>();

		const profile = await loadProfile(db, who.userId);
		return c.json(
			{
				success: true as const,
				data: {
					job,
					application: app_ ? { id: app_.id, status: app_.status, variant_slug: slug } : null,
					profile: profile?.profile ?? null,
					// What the approved fill entered, keyed by the runner's normalised
					// question — the primary source, because it is what was reviewed.
					answers,
					options,
					multi,
					// Every saved answer by its question, for anything the fill did
					// not record (a field added since, a structured block).
					standing: Object.fromEntries(standing.results.map((r) => [r.question, r.answer])),
					resume_pdf_url: slug ? `${RESUME_PDF_URL}?v=${encodeURIComponent(slug)}` : null,
				},
			},
			200
		);
	});
}
