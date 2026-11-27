/**
 * V3 — tailored application packets.
 *
 * POST /jobs/:id/{resume,cover-letter,application-extras,packet-link}
 *
 * The caller (dashboard user, admin/friend) hits these; we pull the job row and
 * proxy title/company/description to resume-api through the edge, over the
 * EDGE binding, as this worker's own service identity (clients/resume.ts).
 * The edge stamps the service tier; resume-api's in-worker gate admits service
 * on these routes.
 *
 * These are plain Hono routes, not app.openapi: their response shape is
 * resume-api's, so they stay out of the OpenAPI schema and dodge zod-openapi's
 * strict handler-return typing. gateAuthed (admin/friend) is registered on each
 * method+path first, then the handler.
 *
 * WHOSE résumé: every call names the person it is for as
 * `on_behalf_of_user_id` (the caller, or the owner the apply runner names), and
 * resume-api builds from that person's own blocks. It honours the field only
 * from this worker's service identity (its ON_BEHALF_CALLER_USER_IDS). Before
 * that, every user's tailored résumé was silently the site owner's. A person
 * resume-api has no blocks for gets a 409, and is seeded once from their
 * applicant profile (resumeSeed.ts); without one, the UI is told to add it.
 */
import type { AppEnv } from '../../types.js';
import { effectiveUserId, gateAuthed, isEffectiveUserError, type JobsApp } from './shared.js';
import { recordEvent } from '../../opEvents.js';
import type { HasExecutionCtx } from '../../background.js';
import { loadProfile } from './fill.js';
import { profileContact, profileResumeText } from '../../resumeSeed.js';
import { callResumeBinding, resumeViaEdge } from '../../clients/resume.js';

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

/** resume-api's 409 codes for a person whose own résumé content is not there yet. */
type MissingContent = 'NO_RESUME_BLOCKS' | 'NO_CONTACT_PROFILE';

async function missingContent(res: Response): Promise<MissingContent | null> {
	if (res.status !== 409) return null;
	try {
		const body: { code?: unknown } = await res.clone().json();
		return body.code === 'NO_RESUME_BLOCKS' || body.code === 'NO_CONTACT_PROFILE'
			? body.code
			: null;
	} catch {
		return null;
	}
}

/** What the UI shows when there is nothing of the person's own to build from. */
export const MISSING_CONTENT_MESSAGE: Record<MissingContent, string> = {
	NO_RESUME_BLOCKS:
		'Your résumé is not set up yet. Paste it into the Résumé box on the Profile page ' +
		'(or fill in your work history there), then try again. Tailored résumés and cover ' +
		'letters are built only from your own résumé.',
	NO_CONTACT_PROFILE:
		'Your contact details are not set up yet. Fill in your applicant profile ' +
		'(Profile page), then try again.',
};

type ForUser = { res: Response } | { refusal: MissingContent };

/**
 * One resume-api call for one person. When resume-api has none of that
 * person's content yet, seed it from their applicant profile and retry once:
 * blocks via `/blocks/import` (which stores the contact profile too), or just
 * the contact profile. With no applicant profile to seed from, the caller gets
 * a refusal to show, never someone else's résumé.
 */
async function callResumeFor(
	c: HasExecutionCtx & { env: AppEnv },
	userId: string,
	path: string,
	payload: Record<string, unknown>
): Promise<ForUser> {
	const body = { ...payload, on_behalf_of_user_id: userId };
	const first = await callResumeBinding(c.env, path, body);
	const missing = await missingContent(first);
	if (!missing) return { res: first };

	const profile = (await loadProfile(c.env.JOB_PLATFORM_DB, userId))?.profile;
	if (!profile) return { refusal: missing };
	if (missing === 'NO_RESUME_BLOCKS') {
		const text = profileResumeText(profile);
		if (!text) return { refusal: missing };
		const seeded = await callResumeBinding(c.env, '/resume/api/blocks/import', {
			on_behalf_of_user_id: userId,
			resume_text: text,
			contact: profileContact(profile),
		});
		// 409 here means someone seeded in between, which is as good.
		if (!seeded.ok && seeded.status !== 409) return { res: seeded };
	} else {
		const put = await callResumeBinding(
			c.env,
			'/resume/api/contact-profile',
			{ on_behalf_of_user_id: userId, contact: profileContact(profile) },
			'PUT'
		);
		if (!put.ok) return { res: put };
	}
	recordEvent(c, {
		level: 'info',
		event: 'tailoring.seeded',
		message: `seeded resume-api ${missing === 'NO_RESUME_BLOCKS' ? 'blocks' : 'contact'} from the applicant profile`,
		context: { user_id: userId, missing },
	});

	const retry = await callResumeBinding(c.env, path, body);
	const still = await missingContent(retry);
	return still ? { refusal: still } : { res: retry };
}

function refusalBody(missing: MissingContent) {
	return {
		success: false as const,
		error: 'Résumé not set up',
		code: missing,
		message: MISSING_CONTENT_MESSAGE[missing],
	};
}

/**
 * Read back a variant resume-api already minted.
 *
 * The `variant` field is load-bearing: on an unknown or expired slug resume-api
 * does NOT 404 — it falls back to the canonical résumé and omits `variant`. So
 * its absence is the "this packet is gone" signal, and taking `content` without
 * checking would quietly tailor a kit to the generic résumé and present the
 * result as job-specific.
 */
async function fetchMintedResume(
	env: AppEnv,
	slug: string
): Promise<{ markdown: string } | { expired: true }> {
	const res = await resumeViaEdge(env, `/resume/api/resume?v=${encodeURIComponent(slug)}`, {
		method: 'GET',
	});
	if (!res.ok) return { expired: true };
	const body: { content?: string; variant?: string } = await res.json();
	if (!body.variant || !body.content) return { expired: true };
	return { markdown: body.content };
}

/**
 * Body parsing for these routes is lenient: a missing or non-JSON body, or
 * JSON that is not an object (`null`, an array), is `{}`.
 */
async function readOptions(c: {
	req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
	try {
		const body: unknown = await c.req.json();
		return typeof body === 'object' && body !== null && !Array.isArray(body)
			? (body as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** The owner a service caller is acting for, when its body names one. */
function ownerNameOf(opts: Record<string, unknown>): string | undefined {
	return typeof opts.ownerName === 'string' ? opts.ownerName : undefined;
}

/**
 * The application form's own free-text questions, as the apply runner sends
 * them: non-empty strings, at most 25, each cut to 500 characters (resume-api
 * applies the same bounds). Anything else is no questions.
 */
function questionsOf(opts: Record<string, unknown>): string[] | undefined {
	if (!Array.isArray(opts.questions)) return undefined;
	const questions = opts.questions
		.filter((q): q is string => typeof q === 'string' && q.trim() !== '')
		.map((q) => q.trim().slice(0, 500))
		.slice(0, 25);
	return questions.length ? questions : undefined;
}

/** What each route asks resume-api to make; the `kind` on its telemetry rows. */
type TailoringKind = 'resume' | 'cover_letter' | 'packet_link' | 'application_extras';

/**
 * Room for resume-api's whole error. Since resume-bot 1e6d0dc it names every
 * provider that failed, in chain order, and the one that matters is usually the
 * LAST (Groq's 429 alone runs ~300 chars); the old 300 cut it off.
 */
const UPSTREAM_DETAIL_CHARS = 1500;

/**
 * resume-api errors surface as 502 with a truncated upstream detail. The
 * request row shows only the 502; resume-api's own status and words go to
 * service_events (`tailoring.failed`).
 */
async function upstreamError(
	c: HasExecutionCtx,
	kind: TailoringKind,
	jobId: string,
	res: Response
) {
	const detail = (await res.text()).slice(0, UPSTREAM_DETAIL_CHARS);
	recordEvent(c, {
		level: 'warn',
		event: 'tailoring.failed',
		message: `${kind} for ${jobId}: resume-api ${res.status}`,
		context: { kind, job_id: jobId, upstream_status: res.status, detail },
	});
	return {
		success: false as const,
		error: 'Upstream error',
		message: `resume-api ${res.status}: ${detail}`,
	};
}

/** One row per LLM generation: they are the spend, and the request row cannot say which kind. */
function generated(
	c: HasExecutionCtx,
	kind: TailoringKind,
	jobId: string,
	extra: Record<string, unknown> = {}
) {
	recordEvent(c, {
		level: 'info',
		event: 'tailoring.generated',
		message: `${kind} for ${jobId}`,
		context: { kind, job_id: jobId, ...extra },
	});
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

		const who = await effectiveUserId(c, ownerNameOf(opts));
		if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);

		const out = await callResumeFor(c, who.userId, '/resume/api/tailored-resume', {
			job_title: job.title,
			company: job.company,
			description: job.description,
			...(typeof opts.profile_type === 'string' ? { profile_type: opts.profile_type } : {}),
			...(typeof opts.tailor === 'boolean' ? { tailor: opts.tailor } : {}),
		});
		if ('refusal' in out) return c.json(refusalBody(out.refusal), 409);
		const res = out.res;
		if (!res.ok) return c.json(await upstreamError(c, 'resume', id, res), 502);
		const data = await res.json();
		generated(c, 'resume', id);
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

		const who = await effectiveUserId(c, ownerNameOf(opts));
		if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);

		const out = await callResumeFor(c, who.userId, '/resume/api/cover-letter', {
			job_title: job.title,
			company: job.company,
			description: job.description,
			...(opts.tone === 'formal' || opts.tone === 'conversational' ? { tone: opts.tone } : {}),
		});
		if ('refusal' in out) return c.json(refusalBody(out.refusal), 409);
		const res = out.res;
		if (!res.ok) return c.json(await upstreamError(c, 'cover_letter', id, res), 502);
		const data = await res.json();
		generated(c, 'cover_letter', id);
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

		// Resolved before minting, so a refused owner name never leaves an orphan
		// variant behind.
		const who = await effectiveUserId(c, ownerNameOf(opts));
		if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);

		// The variant is minted in that person's own space at resume-api, so it
		// is listed to them alone and its PDF carries their name.
		const out = await callResumeFor(c, who.userId, '/resume/api/variants', {
			label: `${job.company} - ${job.title}`,
			markdown: resumeMarkdown,
			...(coverLetterMarkdown ? { cover_letter_markdown: coverLetterMarkdown } : {}),
			company: job.company,
			job_title: job.title,
			ttl_days: ttlDays,
		});
		if ('refusal' in out) return c.json(refusalBody(out.refusal), 409);
		const res = out.res;
		if (!res.ok) return c.json(await upstreamError(c, 'packet_link', id, res), 502);
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
		//
		// For the OWNER when the runner names one. Keyed on the caller, the
		// runner's service identity got the slug and the owner's application row
		// never did, so every fill minted again — and on an approved row the mint's
		// re-queue erased the approval (18 of them, 2026-10-02).
		//
		// A fresh row is a transition (new → saved) and goes on the timeline,
		// written FIRST in the batch so its NOT EXISTS sees the state before it.
		const now = new Date().toISOString();
		const db = c.env.JOB_PLATFORM_DB;
		await db.batch([
			db
				.prepare(
					`INSERT INTO job_events
					   (job_id, user_id, kind, from_state, to_state, note, occurred_at, created_at)
					 SELECT ?1, ?2, 'state', NULL, 'saved', NULL, ?3, ?3
					 WHERE NOT EXISTS (SELECT 1 FROM job_states WHERE job_id = ?1 AND user_id = ?2)`
				)
				.bind(id, who.userId, now),
			db
				.prepare(
					`INSERT INTO job_states (job_id, user_id, state, notes, updated_at, variant_slug)
					 VALUES (?, ?, 'saved', NULL, ?, ?)
					 ON CONFLICT (job_id, user_id) DO UPDATE SET
					   variant_slug = excluded.variant_slug,
					   updated_at = excluded.updated_at`
				)
				.bind(id, who.userId, now, variant.slug),
		]);

		const url = `https://hadoku.me/resume?v=${encodeURIComponent(variant.slug)}`;
		generated(c, 'packet_link', id, { slug: variant.slug, user_id: who.userId });
		return c.json({ success: true as const, data: { slug: variant.slug, url } }, 200);
	});

	// POST /jobs/:id/application-extras — the non-résumé half of the apply kit.
	//
	// We proxy title/company/description + the tailored résumé to resume-api over
	// the service binding, which returns intro email, why-hook, screening answers,
	// salary line, LinkedIn note, talking points and the standard-fields block.
	// Its own edge carve-out, like the other tailoring calls.
	//
	// The résumé can arrive two ways. The dashboard has just generated one and
	// posts it inline. The apply runner has not: it is asking "what are the
	// drafted answers for this job?", and requiring it to carry the résumé to ask
	// that meant it posted `{}` and got a 400 every time — silently, because it
	// treats a failure here as "no drafted answers" and falls back to standing
	// ones. So an absent résumé now resolves from the packet already minted for
	// this job, which is the record of what was actually prepared for it.
	//
	// `questions` are the form's own free-text labels the runner could not
	// answer. resume-api drafts one answer per label into `form_answers`, which
	// passes back untouched with the rest of the kit.
	app.post('/jobs/:id/application-extras', gateAuthed);
	app.post('/jobs/:id/application-extras', async (c) => {
		const id = c.req.param('id');
		const opts = await readOptions(c);
		let resumeMarkdown = typeof opts.resume_markdown === 'string' ? opts.resume_markdown : '';
		// The owner's kit when the runner names one — see packet-link.
		const who = await effectiveUserId(c, ownerNameOf(opts));
		if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);

		if (!resumeMarkdown) {
			const userId = who.userId;
			const row = userId
				? await c.env.JOB_PLATFORM_DB.prepare(
						'SELECT variant_slug FROM job_states WHERE job_id = ? AND user_id = ?'
					)
						.bind(id, userId)
						.first<{ variant_slug: string | null }>()
				: null;
			const slug = row?.variant_slug ?? null;
			if (!slug) {
				return c.json(
					{
						success: false as const,
						error: 'Bad request',
						message:
							'resume_markdown is required, or prepare a packet for this job first — ' +
							'no minted packet was found for this caller.',
					},
					400
				);
			}
			const minted = await fetchMintedResume(c.env, slug);
			if ('expired' in minted) {
				return c.json(
					{
						success: false as const,
						error: 'Bad request',
						message: `The packet for this job ('${slug}') has expired; re-prepare it or post resume_markdown.`,
					},
					400
				);
			}
			resumeMarkdown = minted.markdown;
		}

		const job = await loadTailoringFields(c.env.JOB_PLATFORM_DB, id);
		if (!job) {
			return c.json(
				{ success: false as const, error: 'Not found', message: `Job '${id}' not found` },
				404
			);
		}

		const out = await callResumeFor(c, who.userId, '/resume/api/application-extras', {
			job_title: job.title,
			company: job.company,
			description: job.description,
			resume_markdown: resumeMarkdown,
			// The kit's location answers must speak to THIS job's location, not the
			// candidate's default metro — resume-api injects these into its prompt.
			job_location: job.location ?? undefined,
			workplace_type: job.workplace_type ?? undefined,
			questions: questionsOf(opts),
		});
		if ('refusal' in out) return c.json(refusalBody(out.refusal), 409);
		const res = out.res;
		if (!res.ok) return c.json(await upstreamError(c, 'application_extras', id, res), 502);
		const data = await res.json();
		generated(c, 'application_extras', id);
		return c.json({ success: true as const, data }, 200);
	});
}
