import { classifyDiscipline, levelRank, levelTrack, type RoleLevel } from './roleClassify.js';

export interface ScoreBreakdown {
	title_match: number;
	keyword_match: number;
	level_match: number;
	remote_match: number;
	/** 1.0 for engineering/unknown titles; DISCIPLINE_PENALTY for adjacent
	 *  ladders (PM/design/sales/…) — multiplies the whole score. */
	discipline_factor: number;
}

export interface ScoreResult {
	score: number;
	breakdown: ScoreBreakdown;
}

// Adjacent-ladder roles (Product Manager, designer, sales…) pass the IC/manager
// track filter by design, so without this an SWE profile literally could not
// rank them down — a Staff PM hit a perfect 1.000. A multiplier (not a hard
// filter) keeps them visible at the bottom of the feed instead of silently gone.
const DISCIPLINE_PENALTY = 0.15;

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word matching. The old substring `includes` made the keyword "ai"
// match "maintain", "available", and "GenAI" — inflating title/keyword factors
// on essentially every posting.
function countKeywordMatches(text: string, keywords: string[]): number {
	if (!keywords.length) return 0;
	return keywords.filter((kw) => {
		const trimmed = kw.trim();
		if (!trimmed) return false;
		return new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, 'i').test(text);
	}).length;
}

function titleMatch(title: string, keywords: string[]): number {
	if (!keywords.length) return 0.5;
	const matched = countKeywordMatches(title, keywords);
	return Math.min(1.0, matched / Math.max(1, keywords.length * 0.3));
}

function keywordMatch(description: string, keywords: string[]): number {
	if (!keywords.length) return 0.5;
	const matched = countKeywordMatches(description, keywords);
	// Expect ~40% keyword hit rate for a good match
	return Math.min(1.0, matched / Math.max(1, keywords.length * 0.4));
}

/**
 * How close is the job's rung to the rungs the profile asked for?
 *
 * The old seniorityMatch substring-matched the profile's role_types against the
 * raw title and returned a flat 1.0/0.4 — so a Junior Engineer and a VP of
 * Engineering were penalized identically when you asked for Staff, and a plain
 * "Software Engineer" was penalized for having no modifier at all. This scores
 * against the classified `role_level` instead, and grades the distance:
 *
 *   exact rung          1.0
 *   one rung away       0.7   (Staff when you asked for Principal)
 *   further / off-track 0.2
 *   unclassified job    0.5   (no signal is not a miss)
 */
function levelMatch(jobLevel: RoleLevel | null, wanted: RoleLevel[]): number {
	if (!wanted.length) return 0.5;
	if (!jobLevel) return 0.5;

	const jobRank = levelRank(jobLevel);
	const jobTrack = levelTrack(jobLevel);

	let best = 0.2;
	for (const w of wanted) {
		if (w === jobLevel) return 1.0;
		// Rungs on different ladders aren't comparable — "director" is not one
		// step from "principal", it's a different job.
		if (levelTrack(w) !== jobTrack) continue;
		if (Math.abs(levelRank(w) - jobRank) === 1) best = Math.max(best, 0.7);
	}
	return best;
}

function remoteMatch(workplaceType: string, remotePref: string): number {
	if (remotePref === 'any') return 1.0;
	if (remotePref === 'remote') return workplaceType === 'remote' ? 1.0 : 0.0;
	if (remotePref === 'hybrid') {
		if (workplaceType === 'hybrid') return 1.0;
		if (workplaceType === 'remote') return 0.7;
		return 0.0;
	}
	if (remotePref === 'onsite') return workplaceType === 'onsite' ? 1.0 : 0.0;
	return 0.5;
}

/**
 * Optimistic upper bound on a job's score WITHOUT its description — every
 * factor real except keyword_match, which is assumed perfect (or neutral 0.5
 * when the profile has no keywords, matching keywordMatch exactly). Used by the
 * feed's light pass to rank the whole corpus cheaply: a job excluded from the
 * full-scoring shortlist has a bound below the shortlist's floor, so it could
 * never have out-ranked the shortlist even with a perfect description match.
 */
export function scoreJobUpperBound(
	job: {
		title: string;
		workplace_type: string;
		role_level: RoleLevel | null;
	},
	profile: {
		keywords: string[];
		levels: RoleLevel[];
		remote_pref: string;
	}
): number {
	const breakdown: ScoreBreakdown = {
		title_match: titleMatch(job.title, profile.keywords),
		keyword_match: profile.keywords.length ? 1.0 : 0.5,
		level_match: levelMatch(job.role_level, profile.levels),
		remote_match: remoteMatch(job.workplace_type, profile.remote_pref),
		discipline_factor: classifyDiscipline(job.title) === 'adjacent' ? DISCIPLINE_PENALTY : 1.0,
	};
	return composeScore(breakdown);
}

function composeScore(breakdown: ScoreBreakdown): number {
	const score =
		(breakdown.title_match * 0.3 +
			breakdown.keyword_match * 0.4 +
			breakdown.level_match * 0.15 +
			breakdown.remote_match * 0.15) *
		breakdown.discipline_factor;
	return Math.round(score * 1000) / 1000;
}

export function scoreJob(
	job: {
		title: string;
		description: string;
		workplace_type: string;
		role_level: RoleLevel | null;
	},
	profile: {
		keywords: string[];
		levels: RoleLevel[];
		remote_pref: string;
	}
): ScoreResult {
	const breakdown: ScoreBreakdown = {
		title_match: titleMatch(job.title, profile.keywords),
		keyword_match: keywordMatch(job.description, profile.keywords),
		level_match: levelMatch(job.role_level, profile.levels),
		remote_match: remoteMatch(job.workplace_type, profile.remote_pref),
		discipline_factor: classifyDiscipline(job.title) === 'adjacent' ? DISCIPLINE_PENALTY : 1.0,
	};

	// Two criteria are hard filters applied in SQL rather than score factors:
	// the profile's companies, and its track (IC vs manager). Salary is a view
	// filter now — its old 0.06 weight was mostly noise, since salary_min is
	// NULL on most postings and the factor returned a neutral 0.5 for all of
	// them.
	return { score: composeScore(breakdown), breakdown };
}
