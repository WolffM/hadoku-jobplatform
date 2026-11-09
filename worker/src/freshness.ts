/**
 * Is a posting still listed? The one definition, shared by the apply queue
 * (applications.ts, which marks a queued application job_closed), GET /pipeline
 * and GET /jobs/:id.
 *
 * Ingest bumps `last_seen_at` on every job a scrape re-encounters, so a posting
 * still on its board keeps pace with its siblings and one that has been pulled
 * falls behind. The comparison is against THE SAME BOARD's newest stamp rather
 * than wall-clock age, which is what makes it safe: if the scraper breaks, a
 * target is disabled, or auth lapses, every job on that board stops advancing
 * together and none of them looks dead. "Our scraper is broken" must never read
 * as "every job closed".
 *
 * The window exists because one scrape run is not instantaneous — it arrives as
 * batches of 25, each stamped when it lands, so jobs from a single run differ by
 * minutes. Runs are daily. Twelve hours is comfortably wider than any one run
 * and comfortably narrower than a missed one.
 *
 * Only board-sourced jobs can be judged: keyword-feed sources (RemoteOK, a
 * pasted page, a posting typed in by hand) have no board to be absent from, so
 * `ats`/`slug` are empty and the answer is "not closed".
 */
import type { D1Database } from '@cloudflare/workers-types';

export const DELISTED_LAG_MS = 12 * 60 * 60 * 1000;

export interface BoardPosting {
	ats: string | null;
	slug: string | null;
	last_seen_at: string | null;
}

const boardKey = (ats: string, slug: string) => `${ats}\u0000${slug}`;

/** Has a posting seen at `lastSeen` fallen behind its board's newest `boardNewest`? */
export function isDelisted(lastSeen: string | null, boardNewest: string | null): boolean {
	if (!lastSeen || !boardNewest) return false;
	const seen = Date.parse(lastSeen);
	const newest = Date.parse(boardNewest);
	if (Number.isNaN(seen) || Number.isNaN(newest)) return false;
	return newest - seen > DELISTED_LAG_MS;
}

/**
 * Each board's newest `last_seen_at`, one grouped query for all of them (a
 * pipeline names tens of boards). Rides idx_jobs_ats_slug; no index on
 * last_seen_at, which every nightly liveness bump would have to rewrite.
 */
export async function boardNewest(
	db: D1Database,
	postings: BoardPosting[]
): Promise<Map<string, string>> {
	const boards = new Map<string, { ats: string; slug: string }>();
	for (const p of postings) {
		if (p.ats && p.slug) boards.set(boardKey(p.ats, p.slug), { ats: p.ats, slug: p.slug });
	}
	const out = new Map<string, string>();
	const list = [...boards.values()];
	// D1 caps bound parameters per statement at 100: two per board.
	for (let i = 0; i < list.length; i += 45) {
		const chunk = list.slice(i, i + 45);
		const res = await db
			.prepare(
				`SELECT ats, slug, MAX(last_seen_at) AS newest FROM jobs
				 WHERE ${chunk.map(() => '(ats = ? AND slug = ?)').join(' OR ')}
				 GROUP BY ats, slug`
			)
			.bind(...chunk.flatMap((b) => [b.ats, b.slug]))
			.all<{ ats: string; slug: string; newest: string | null }>();
		for (const r of res.results) if (r.newest) out.set(boardKey(r.ats, r.slug), r.newest);
	}
	return out;
}

/** Whether each posting has been taken down, in order. */
export async function closedFlags(db: D1Database, postings: BoardPosting[]): Promise<boolean[]> {
	const newest = await boardNewest(db, postings);
	return postings.map((p) =>
		p.ats && p.slug
			? isDelisted(p.last_seen_at, newest.get(boardKey(p.ats, p.slug)) ?? null)
			: false
	);
}
