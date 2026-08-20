/**
 * V3 — tailored application packets.
 *
 * POST /jobs/:id/{resume,cover-letter,application-extras,packet-link}
 *
 * The caller (dashboard user, admin/friend) hits these; we pull the job row and
 * proxy title/company/description to resume-api over a Cloudflare service
 * binding. The binding bypasses the public edge, so we stamp X-Edge-Auth +
 * X-Hadoku-Tier: service ourselves — resume-api's in-worker gate admits service
 * on these routes.
 *
 * These are plain Hono routes, not app.openapi: their response shape is
 * resume-api's, so they stay out of the OpenAPI schema and dodge zod-openapi's
 * strict handler-return typing. gateAuthed (admin/friend) is registered on each
 * method+path first, then the handler.
 */
import type { AppEnv } from '../../types.js';
import { gateAuthed, maybeUserId, type JobsApp } from './shared.js';

interface JobTailoringFields {
	title: string;
	company: string;
	description: string;
	location: string | null;
	workplace_type: string | null;
}

async function loadTailoringFields(
	db: AppEnv['JOB_PLATFORM_DB'],
	id: string
): Promise<JobTailoringFields | null> {
	return db
		.prepare('SELECT title, company, description, location, workplace_type FROM jobs WHERE id = ?')
		.bind(id)
		.first<JobTailoringFields>();
}

async function callResumeBinding(
	env: AppEnv,
	path: string,
	payload: Record<string, unknown>
): Promise<Response> {
	if (!env.RESUME) {
		throw new Error('RESUME service binding not configured');
	}
	return env.RESUME.fetch(`https://resume-api${path}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Edge-Auth': env.EDGE_AUTH_SECRET ?? '',
			'X-Hadoku-Tier': 'service',
		},
		body: JSON.stringify(payload),
	});
}

/** Body parsing for these routes is lenient — a missing/!JSON body is `{}`. */
async function readOptions(c: { req: { json: () => Promise<unknown> } }) {
	try {
		return (await c.req.json()) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** resume-api errors surface as 502 with a truncated upstream detail. */
async function upstreamError(res: Response) {
	const detail = await res.text();
	return {
		success: false as const,
		error: 'Upstream error',
		message: `resume-api ${res.status}: ${detail.slice(0, 300)}`,
	};
}

export function registerTailoringRoutes(app: JobsApp): void {
	app.post('/jobs/:id/resume', gateAuthed);
	app.post('/jobs/:id/cover-letter', gateAuthed);

	app.post('/jobs/:id/resume', async (c) => {
		const id = c.req.param('id');
		const opts = await readOptions(c);
		const job = await loadTailoringFields(c.env.JOB_PLATFORM_DB, id);
		if (!job) {
			return c.json(
				{ success: false as const, error: 'Not found', message: `Job '${id}' not found` },
				404
			);
		}

		const res = await callResumeBinding(c.env, '/resume/api/tailored-resume', {
			job_title: job.title,
			company: job.company,
			description: job.description,
			...(typeof opts.profile_type === 'string' ? { profile_type: opts.profile_type } : {}),
			...(typeof opts.tailor === 'boolean' ? { tailor: opts.tailor } : {}),
		});
		if (!res.ok) return c.json(await upstreamError(res), 502);
		const data = await res.json();
		return c.json({ success: true as const, data }, 200);
	});

	app.post('/jobs/:id/cover-letter', async (c) => {
		const id = c.req.param('id');
		const opts = await readOptions(c);
		const job = await loadTailoringFields(c.env.JOB_PLATFORM_DB, id);
		if (!job) {
			return c.json(
				{ success: false as const, error: 'Not found', message: `Job '${id}' not found` },
				404
			);
		}

		const res = await callResumeBinding(c.env, '/resume/api/cover-letter', {
			job_title: job.title,
			company: job.company,
			description: job.description,
			...(opts.tone === 'formal' || opts.tone === 'conversational' ? { tone: opts.tone } : {}),
		});
		if (!res.ok) return c.json(await upstreamError(res), 502);
		const data = await res.json();
		return c.json({ success: true as const, data }, 200);
	});

	// POST /jobs/:id/packet-link — mint a shareable résumé+cover-letter packet link.
	//
	// The client generates the résumé and cover letter first (the two routes above,
	// each fast under its own edge carve-out) and posts the finished markdown here.
	// We mint a resume-api variant with that PRE-RENDERED content — no LLM at mint,
	// so it returns instantly and never risks the edge timeout — and hand back the
	// public hadoku.me/resume?v={slug} link. resume-api's /variants admits our
	// service-tier binding call (requireMinTier('friend')).
	app.post('/jobs/:id/packet-link', gateAuthed);
	app.post('/jobs/:id/packet-link', async (c) => {
		const id = c.req.param('id');
		const opts = await readOptions(c);
		const resumeMarkdown = typeof opts.resume_markdown === 'string' ? opts.resume_markdown : '';
		if (!resumeMarkdown) {
			return c.json(
				{ success: false as const, error: 'Bad request', message: 'resume_markdown is required' },
				400
			);
		}
		const coverLetterMarkdown =
			typeof opts.cover_letter_markdown === 'string' ? opts.cover_letter_markdown : undefined;
		// Default 365d — a variant is ~8.6KB in KV, so long retention is effectively
		// free (KV caps at 25MB/value); a stale shared link outliving its usefulness
		// is a better failure than one that 404s while someone's still considering it.
		const ttlDays = typeof opts.ttl_days === 'number' ? opts.ttl_days : 365;

		const job = await loadTailoringFields(c.env.JOB_PLATFORM_DB, id);
		if (!job) {
			return c.json(
				{ success: false as const, error: 'Not found', message: `Job '${id}' not found` },
				404
			);
		}

		const res = await callResumeBinding(c.env, '/resume/api/variants', {
			label: `${job.company} — ${job.title}`,
			markdown: resumeMarkdown,
			...(coverLetterMarkdown ? { cover_letter_markdown: coverLetterMarkdown } : {}),
			company: job.company,
			job_title: job.title,
			ttl_days: ttlDays,
		});
		if (!res.ok) return c.json(await upstreamError(res), 502);
		const variant: { slug?: string } = await res.json();
		if (!variant.slug) {
			return c.json(
				{
					success: false as const,
					error: 'Upstream error',
					message: 'resume-api returned no slug',
				},
				502
			);
		}
		// Minting IS the record: link the slug to this job for the caller so the
		// Packets view finds it without a separate state click. Existing state is
		// preserved; a fresh row lands as 'saved' (generating a packet implies at
		// least that much interest). The owner generated two packets that were
		// unfindable because nothing wrote this row — never again.
		const userId = await maybeUserId(c);
		if (userId) {
			const now = new Date().toISOString();
			await c.env.JOB_PLATFORM_DB.prepare(
				`INSERT INTO job_states (job_id, user_id, state, notes, updated_at, variant_slug)
				 VALUES (?, ?, 'saved', NULL, ?, ?)
				 ON CONFLICT (job_id, user_id) DO UPDATE SET
				   variant_slug = excluded.variant_slug,
				   updated_at = excluded.updated_at`
			)
				.bind(id, userId, now, variant.slug)
				.run();
		}

		const url = `https://hadoku.me/resume?v=${encodeURIComponent(variant.slug)}`;
		return c.json({ success: true as const, data: { slug: variant.slug, url } }, 200);
	});

	// POST /jobs/:id/application-extras — the non-résumé half of the apply kit.
	//
	// The client generates the tailored résumé first (POST /jobs/:id/resume) and
	// posts its markdown here; we proxy title/company/description + that résumé to
	// resume-api over the service binding, which returns intro email, why-hook,
	// screening answers, salary line, LinkedIn note, talking points and the
	// standard-fields block. Its own edge carve-out, like the other tailoring calls.
	app.post('/jobs/:id/application-extras', gateAuthed);
	app.post('/jobs/:id/application-extras', async (c) => {
		const id = c.req.param('id');
		const opts = await readOptions(c);
		const resumeMarkdown = typeof opts.resume_markdown === 'string' ? opts.resume_markdown : '';
		if (!resumeMarkdown) {
			return c.json(
				{ success: false as const, error: 'Bad request', message: 'resume_markdown is required' },
				400
			);
		}

		const job = await loadTailoringFields(c.env.JOB_PLATFORM_DB, id);
		if (!job) {
			return c.json(
				{ success: false as const, error: 'Not found', message: `Job '${id}' not found` },
				404
			);
		}

		const res = await callResumeBinding(c.env, '/resume/api/application-extras', {
			job_title: job.title,
			company: job.company,
			description: job.description,
			resume_markdown: resumeMarkdown,
			// The kit's location answers must speak to THIS job's location, not the
			// candidate's default metro — resume-api injects these into its prompt.
			job_location: job.location ?? undefined,
			workplace_type: job.workplace_type ?? undefined,
		});
		if (!res.ok) return c.json(await upstreamError(res), 502);
		const data = await res.json();
		return c.json({ success: true as const, data }, 200);
	});
}
