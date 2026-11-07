/**
 * GET /insights — the caller's search, summarised: JobPulse's analytics view,
 * computed from the rows this app already keeps.
 *
 * "Reached a stage" is read from three places, because no one of them is
 * complete:
 *
 *   job_events     every transition since 2026-11-06 (migration 0028)
 *   applications   the runner's 'submitted', which never writes a state
 *   job_states     the state now — the only record for a posting marked
 *                  'interviewing' before there was a timeline to say when
 *
 * A posting counts as applied when any of them says so; as interviewed when it
 * is or was interviewing or offered; as responded when it was interviewed or
 * rejected (an answer, if not the hoped-for one). Rates are shares of applied.
 *
 * The person's pipeline is tens to hundreds of postings, so this reads it whole
 * and counts in JS; the only per-row cost is one skill scan per description.
 */
import { createRoute } from '@hono/zod-openapi';
import { IdentityErrorResponseSchema, InsightsResponseSchema } from '../../schemas.js';
import { canonicalSkill, extractSkills } from '../../skills.js';
import {
	effectiveUserId,
	gateAuthed,
	isEffectiveUserError,
	ownerNameQuery,
	type JobsApp,
} from './shared.js';

const WEEKS = 12;
const TOP_SKILLS = 15;

const APPLIED_OR_LATER = new Set(['applied', 'interviewing', 'offered', 'rejected']);
const INTERVIEWED = new Set(['interviewing', 'offered']);

/** Monday 00:00 UTC of the week holding `iso`, as YYYY-MM-DD. */
export function weekOf(iso: string): string {
	const d = new Date(iso);
	const sinceMonday = (d.getUTCDay() + 6) % 7;
	d.setUTCDate(d.getUTCDate() - sinceMonday);
	return d.toISOString().slice(0, 10);
}

function parseList(raw: string): string[] {
	try {
		const v: unknown = JSON.parse(raw);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		// A malformed stack column is an empty stack — the same default
		// migration 0011 gives every profile.
		return [];
	}
}

const ERRORS = {
	403: {
		description: 'Forbidden',
		content: { 'application/json': { schema: IdentityErrorResponseSchema } },
	},
	404: {
		description: 'No such owner name',
		content: { 'application/json': { schema: IdentityErrorResponseSchema } },
	},
	409: {
		description: 'That owner name has never signed in',
		content: { 'application/json': { schema: IdentityErrorResponseSchema } },
	},
	503: {
		description: 'Identity could not be resolved right now — retry',
		content: { 'application/json': { schema: IdentityErrorResponseSchema } },
	},
};

export function registerInsightsRoute(app: JobsApp): void {
	app.get('/insights', gateAuthed);
	app.openapi(
		createRoute({
			method: 'get',
			path: '/insights',
			tags: ['Pipeline'],
			summary: "The caller's funnel, response rates, weekly pace, workplace mix and skill demand",
			request: { query: ownerNameQuery },
			responses: {
				200: {
					description: 'Insights',
					content: { 'application/json': { schema: InsightsResponseSchema } },
				},
				...ERRORS,
			},
		}),
		async (c) => {
			const who = await effectiveUserId(c, c.req.valid('query').ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const db = c.env.JOB_PLATFORM_DB;

			const [stateCounts, rows, transitions, submitted, profiles] = await db.batch([
				db
					.prepare('SELECT state, COUNT(*) AS n FROM job_states WHERE user_id = ? GROUP BY state')
					.bind(who.userId),
				// Dismissed postings are counted above and nowhere else: they are not
				// part of the search, and there can be thousands of them.
				db
					.prepare(
						`SELECT js.job_id, js.state, js.updated_at, j.workplace_type, j.description
						 FROM job_states js JOIN jobs j ON j.id = js.job_id
						 WHERE js.user_id = ? AND js.state != 'dismissed'`
					)
					.bind(who.userId),
				db
					.prepare(
						`SELECT job_id, to_state, occurred_at FROM job_events
						 WHERE user_id = ? AND kind = 'state'`
					)
					.bind(who.userId),
				db
					.prepare(
						`SELECT job_id, updated_at FROM applications
						 WHERE user_id = ? AND status = 'submitted'`
					)
					.bind(who.userId),
				db.prepare('SELECT stack FROM profiles WHERE user_id = ?').bind(who.userId),
			]);

			const states: Record<string, number> = {};
			for (const r of stateCounts.results as { state: string; n: number }[]) states[r.state] = r.n;

			// Per posting: every state it has been in, and when it was applied to.
			const been = new Map<string, Set<string>>();
			const appliedAt = new Map<string, string>();
			const earliest = (id: string, at: string) => {
				const cur = appliedAt.get(id);
				if (!cur || at < cur) appliedAt.set(id, at);
			};
			const mark = (id: string, state: string) => {
				let s = been.get(id);
				if (!s) been.set(id, (s = new Set()));
				s.add(state);
			};
			for (const t of transitions.results as {
				job_id: string;
				to_state: string | null;
				occurred_at: string;
			}[]) {
				if (!t.to_state) continue;
				mark(t.job_id, t.to_state);
				if (t.to_state === 'applied') earliest(t.job_id, t.occurred_at);
			}
			for (const a of submitted.results as { job_id: string; updated_at: string }[]) {
				mark(a.job_id, 'applied');
				earliest(a.job_id, a.updated_at);
			}

			interface Row {
				job_id: string;
				state: string;
				updated_at: string;
				workplace_type: string;
				description: string;
			}
			const pipeline = rows.results as Row[];
			const workplaceById = new Map<string, string>();
			for (const r of pipeline) {
				mark(r.job_id, r.state);
				workplaceById.set(r.job_id, r.workplace_type || 'unknown');
				// A posting already past 'applied' with no record of when: the
				// state's own timestamp is the best date there is.
				if (APPLIED_OR_LATER.has(r.state)) earliest(r.job_id, r.updated_at);
			}

			let applied = 0;
			let interviewed = 0;
			let offered = 0;
			let responded = 0;
			const workplace = new Map<string, number>();
			for (const [id, s] of been) {
				const isApplied = [...s].some((x) => APPLIED_OR_LATER.has(x));
				if (!isApplied) continue;
				applied++;
				const iv = [...s].some((x) => INTERVIEWED.has(x));
				if (iv) interviewed++;
				if (s.has('offered')) offered++;
				if (iv || s.has('rejected')) responded++;
				const w = workplaceById.get(id);
				// A submitted application whose posting has since left the
				// person's pipeline has no row to say what it was.
				if (w) workplace.set(w, (workplace.get(w) ?? 0) + 1);
			}
			const share = (n: number) => (applied ? n / applied : null);

			// The last WEEKS Mondays, oldest first, every one present.
			const thisWeek = weekOf(new Date().toISOString());
			const weeks: string[] = [];
			for (let i = WEEKS - 1; i >= 0; i--) {
				const d = new Date(`${thisWeek}T00:00:00Z`);
				d.setUTCDate(d.getUTCDate() - 7 * i);
				weeks.push(d.toISOString().slice(0, 10));
			}
			const perWeek = new Map(weeks.map((w) => [w, 0]));
			for (const at of appliedAt.values()) {
				const w = weekOf(at);
				if (perWeek.has(w)) perWeek.set(w, perWeek.get(w)! + 1);
			}

			const stack = new Set(
				(profiles.results as { stack: string }[]).flatMap((p) =>
					parseList(p.stack).map(canonicalSkill)
				)
			);
			const demand = new Map<string, number>();
			let skillPostings = 0;
			for (const r of pipeline) {
				if (!r.description) continue;
				skillPostings++;
				for (const s of extractSkills(r.description)) demand.set(s, (demand.get(s) ?? 0) + 1);
			}
			const skills = [...demand]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.slice(0, TOP_SKILLS)
				.map(([skill, postings]) => ({ skill, postings, in_stack: stack.has(skill) }));

			return c.json(
				{
					success: true as const,
					data: {
						states,
						reached: { applied, responded, interviewed, offered },
						rates: {
							response: share(responded),
							interview: share(interviewed),
							offer: share(offered),
						},
						weekly_applied: weeks.map((week) => ({ week, count: perWeek.get(week)! })),
						workplace: [...workplace]
							.sort((a, b) => b[1] - a[1])
							.map(([workplace_type, count]) => ({ workplace_type, count })),
						skills,
						skill_postings: skillPostings,
					},
				},
				200
			);
		}
	);
}
