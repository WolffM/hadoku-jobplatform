import { classifyDiscipline, levelRank, levelTrack, type RoleLevel } from './roleClassify.js';

/**
 * Scoring v2 (2026-08-19). The v1 model was a threshold, not a ranking: its
 * clamped ratios saturated at 1.0 for hundreds of postings once the corpus
 * grew past the 9 curated boards, and three axes the owner actually decides on
 * — pay, geography, what the work IS — were not in the model at all. v2 is a
 * graded ranking function with negative evidence:
 *
 *   relevance        keyword evidence with diminishing returns; title hits
 *                    outweigh description hits; specific keywords outweigh
 *                    generic ones. Soft-OR composition — never clamps to 1.
 *   level_match      unchanged from v1 (distance on the ladder) — it worked.
 *   geo_fit          remote/hybrid preference × country signal. Explicitly
 *                    non-Americas remote is a multiplicative sink (×0.1):
 *                    "Remote Spain" must not tie with "U.S. Remote".
 *   comp_fit         published salary vs the profile's salary_floor. Unpublished
 *                    is NEUTRAL (most strong payers don't publish). Published
 *                    far below floor is a multiplicative sink (×0.15).
 *   stack_fit        tech named in the TITLE that the profile's stack lacks
 *                    ("(Ruby/Rails)") grades down — a fit signal, not a filter.
 *   domain_interest  per-profile ± phrase lists over title+description: what
 *                    the work is about matters (gen-AI > ads), softly.
 *   discipline_factor unchanged from v1 (adjacent ladders ×0.15).
 */

export interface ScoreBreakdown {
	relevance: number;
	level_match: number;
	geo_fit: number;
	comp_fit: number;
	stack_fit: number;
	domain_interest: number;
	/** ×1 or ×DISCIPLINE_PENALTY — multiplies the whole score. */
	discipline_factor: number;
}

export interface ScoreResult {
	score: number;
	breakdown: ScoreBreakdown;
}

export interface ScorableJobLight {
	title: string;
	location: string | null;
	workplace_type: string;
	salary_max: number | null;
	role_level: RoleLevel | null;
}

export interface ScorableJob extends ScorableJobLight {
	description: string;
}

export interface ScoringProfile {
	keywords: string[];
	levels: RoleLevel[];
	remote_pref: string;
	/** Techs the owner can credibly claim; title-named tech outside it grades down. */
	stack: string[];
	/** Domains that make work interesting / boring. Grown by feedback mining. */
	interests_like: string[];
	interests_avoid: string[];
	/** Comp floor in USD; null disables the comp axis (neutral 0.5). */
	salary_floor: number | null;
}

const WEIGHTS = {
	relevance: 0.4,
	level_match: 0.15,
	geo_fit: 0.12,
	comp_fit: 0.1,
	stack_fit: 0.08,
	domain_interest: 0.15,
} as const;

const DISCIPLINE_PENALTY = 0.15;
const NON_AMERICAS_PENALTY = 0.1;
const LOWBALL_PENALTY = 0.15;
/** Estimated TOTAL comp below this fraction of the floor is a lowball sink. */
const LOWBALL_RATIO = 0.75;
/** Posted ranges are BASE salary; the floor is TOTAL comp. Equity/bonus at the
 *  target tier typically adds ~40%, so estimated_total = base × 1.4 — a 250k
 *  base ≈ the 350k total-comp target (owner calibration, 2026-08-19). */
const BASE_TO_TOTAL = 1.4;

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Compiled word-boundary matchers, keyed by phrase.
//
// wordHit is the hottest function in the worker: the feed's light pass calls it
// once per (job × keyword/interest) pair, so a 30k-row corpus scored against a
// profile with 6 keywords and 37 interest phrases rebuilt the SAME few dozen
// patterns two and a half million times per request. The distinct phrases are
// the union of every profile's criteria plus TITLE_TECH — low hundreds — so
// they are worth compiling once and keeping.
const WORD_RE = new Map<string, RegExp>();

function wordRe(phrase: string): RegExp {
	let re = WORD_RE.get(phrase);
	if (!re) {
		re = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i');
		WORD_RE.set(phrase, re);
	}
	return re;
}

function wordHit(text: string, phrase: string): boolean {
	const trimmed = phrase.trim();
	if (!trimmed) return false;
	return wordRe(trimmed).test(text);
}

// ── relevance ────────────────────────────────────────────────────────────────

// Terms so common in this corpus that matching one says almost nothing.
const GENERIC_TERMS = new Set([
	'software engineer',
	'engineer',
	'developer',
	'backend',
	'frontend',
	'platform',
	'cloud',
	'ai',
	'ml',
	'data',
]);

function keywordWeight(kw: string): number {
	const k = kw.trim().toLowerCase();
	if (!k) return 0;
	if (GENERIC_TERMS.has(k)) return 0.12;
	return k.includes(' ') ? 0.3 : 0.2;
}

/**
 * Soft-OR evidence: each keyword contributes independently with diminishing
 * returns (1 - Π(1-wᵢ)), so more/better matches always rank higher but the
 * axis approaches 1.0 asymptotically instead of clamping there. Title hits
 * count double (capped) — a keyword in the title is what the job IS.
 */
function relevance(title: string, description: string, keywords: string[]): number {
	if (!keywords.length) return 0.5;
	let miss = 1;
	for (const kw of keywords) {
		const w = keywordWeight(kw);
		if (w === 0) continue;
		let contribution = 0;
		if (wordHit(title, kw)) contribution = Math.min(0.5, w * 2);
		else if (wordHit(description, kw)) contribution = w;
		miss *= 1 - contribution;
	}
	return round3(1 - miss);
}

/** Optimistic variant for the feed's light pass: title evidence is real,
 *  description evidence assumed present for every keyword the title missed. */
function relevanceUpperBound(title: string, keywords: string[]): number {
	if (!keywords.length) return 0.5;
	let miss = 1;
	for (const kw of keywords) {
		const w = keywordWeight(kw);
		if (w === 0) continue;
		const contribution = wordHit(title, kw) ? Math.min(0.5, w * 2) : w;
		miss *= 1 - contribution;
	}
	return round3(1 - miss);
}

// ── level (unchanged from v1 — distance on the ladder) ──────────────────────

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

// ── geo ──────────────────────────────────────────────────────────────────────

// Explicit non-Americas signals in a location string. Americas timezones are
// workable for a continental-US schedule; Europe/Asia/Africa/Oceania are not.
// Word-boundary matching keeps "UK" from firing inside "Ukraine" etc.
const NON_AMERICAS = new RegExp(
	'\\b(?:emea|apac|europe|spain|poland|germany|france|netherlands|ireland|' +
		'portugal|italy|romania|czechia|czech republic|hungary|austria|belgium|' +
		'denmark|sweden|norway|finland|estonia|lithuania|latvia|greece|serbia|' +
		'croatia|bulgaria|slovakia|slovenia|switzerland|luxembourg|ukraine|' +
		'uk|u\\.k\\.|united kingdom|england|scotland|london|india|pakistan|' +
		'bangladesh|philippines|vietnam|indonesia|malaysia|singapore|thailand|' +
		'china|japan|korea|taiwan|hong kong|israel|turkey|uae|dubai|egypt|' +
		'nigeria|kenya|south africa|australia|new zealand)\\b',
	'i'
);

const AMERICAS_HINT = new RegExp(
	'\\b(?:us|u\\.s\\.|usa|united states|america|americas|canada|latam|brazil|' +
		'mexico|argentina|colombia|chile|peru|costa rica)\\b',
	'i'
);

function remotePrefMatch(workplaceType: string, remotePref: string): number {
	if (remotePref === 'any') return 1.0;
	if (remotePref === 'remote') {
		if (workplaceType === 'remote') return 1.0;
		if (workplaceType === 'hybrid') return 0.35;
		return 0.15;
	}
	if (remotePref === 'hybrid') {
		if (workplaceType === 'hybrid') return 1.0;
		if (workplaceType === 'remote') return 0.7;
		return 0.15;
	}
	if (remotePref === 'onsite') return workplaceType === 'onsite' ? 1.0 : 0.15;
	return 0.5;
}

function geoFit(
	location: string | null,
	workplaceType: string,
	remotePref: string
): { fit: number; penalty: number } {
	const loc = location ?? '';
	const base = remotePrefMatch(workplaceType, remotePref);
	if (NON_AMERICAS.test(loc) && !AMERICAS_HINT.test(loc)) {
		return { fit: Math.min(base, NON_AMERICAS_PENALTY), penalty: NON_AMERICAS_PENALTY };
	}
	// Known-Americas scores the preference cleanly; an unparseable location gets
	// a small haircut so explicit US postings edge it out.
	const known = AMERICAS_HINT.test(loc);
	return { fit: round3(known ? base : base * 0.85), penalty: 1 };
}

// ── comp ─────────────────────────────────────────────────────────────────────

function compFit(salaryMax: number | null, floor: number | null): { fit: number; penalty: number } {
	if (!salaryMax || !floor) return { fit: 0.5, penalty: 1 };
	const ratio = (salaryMax * BASE_TO_TOTAL) / floor;
	if (ratio >= 1) return { fit: round3(Math.min(1, 0.9 + (ratio - 1) * 0.2)), penalty: 1 };
	if (ratio >= LOWBALL_RATIO) {
		// Acceptable territory (owner: even ~200k base is fine): NEVER below
		// neutral, rising monotonically to 0.9 at the floor. Published-and-
		// acceptable must not score worse than unpublished (0.5).
		const t = (ratio - LOWBALL_RATIO) / (1 - LOWBALL_RATIO);
		return { fit: round3(0.5 + t * 0.4), penalty: 1 };
	}
	return { fit: 0.1, penalty: LOWBALL_PENALTY };
}

// ── stack ────────────────────────────────────────────────────────────────────

// Techs that, named in a TITLE, define the role's stack. Deliberately excludes
// ambiguous tokens ('go', 'c') and anything in the owner-common set that would
// never be a surprise requirement.
const TITLE_TECH = [
	'ruby',
	'rails',
	'php',
	'laravel',
	'elixir',
	'erlang',
	'scala',
	'clojure',
	'haskell',
	'perl',
	'cobol',
	'fortran',
	'salesforce',
	'apex',
	'sap',
	'abap',
	'servicenow',
	'workday',
	'java',
	'kotlin',
	'swift',
	'objective-c',
	'ios',
	'android',
	'flutter',
	'unity',
	'unreal',
	'golang',
	'rust',
	'c\\+\\+',
	'c#',
	'\\.net',
	'python',
	'typescript',
	'javascript',
	'react',
	'angular',
	'vue',
	'node',
] as const;

// TITLE_TECH is a module constant, so its 39 matchers are built once at load
// rather than per job — the light pass called this for every row in the corpus.
const TITLE_TECH_RE: [RegExp, string][] = TITLE_TECH.map((tech) => [
	new RegExp(`(?:^|[^a-z0-9+#.])${tech}(?:[^a-z0-9+#]|$)`, 'i'),
	tech.replace(/\\/g, ''),
]);

function titleTechs(title: string): string[] {
	const hits: string[] = [];
	for (const [re, name] of TITLE_TECH_RE) {
		if (re.test(title)) hits.push(name);
	}
	return hits;
}

function stackFit(title: string, stack: string[]): number {
	const named = titleTechs(title);
	if (named.length === 0) return 1.0;
	const known = new Set(stack.map((s) => s.trim().toLowerCase()));
	const foreign = named.filter((t) => !known.has(t.toLowerCase()));
	if (foreign.length === 0) return 1.0;
	return foreign.length === 1 ? 0.35 : 0.2;
}

// ── domain interest ──────────────────────────────────────────────────────────

function domainInterest(
	title: string,
	description: string,
	like: string[],
	avoid: string[]
): number {
	if (!like.length && !avoid.length) return 0.5;
	let delta = 0;
	let likeBoost = 0;
	let avoidDrag = 0;
	for (const phrase of like) {
		if (wordHit(title, phrase)) likeBoost += 0.25;
		else if (wordHit(description, phrase)) likeBoost += 0.1;
	}
	for (const phrase of avoid) {
		if (wordHit(title, phrase)) avoidDrag += 0.3;
		else if (wordHit(description, phrase)) avoidDrag += 0.12;
	}
	delta = Math.min(0.5, likeBoost) - Math.min(0.5, avoidDrag);
	return round3(Math.min(1, Math.max(0, 0.5 + delta)));
}

/** Optimistic variant: title signals real, every like assumed present in the
 *  description, no avoids assumed beyond the title's. */
function domainInterestUpperBound(title: string, like: string[], avoid: string[]): number {
	if (!like.length && !avoid.length) return 0.5;
	let likeBoost = 0;
	let avoidDrag = 0;
	for (const phrase of like) likeBoost += wordHit(title, phrase) ? 0.25 : 0.1;
	for (const phrase of avoid) if (wordHit(title, phrase)) avoidDrag += 0.3;
	const delta = Math.min(0.5, likeBoost) - Math.min(0.5, avoidDrag);
	return round3(Math.min(1, Math.max(0, 0.5 + delta)));
}

// ── composition ──────────────────────────────────────────────────────────────

function compose(breakdown: ScoreBreakdown, penalties: number): number {
	const weighted =
		breakdown.relevance * WEIGHTS.relevance +
		breakdown.level_match * WEIGHTS.level_match +
		breakdown.geo_fit * WEIGHTS.geo_fit +
		breakdown.comp_fit * WEIGHTS.comp_fit +
		breakdown.stack_fit * WEIGHTS.stack_fit +
		breakdown.domain_interest * WEIGHTS.domain_interest;
	return round3(weighted * breakdown.discipline_factor * penalties);
}

export function scoreJob(job: ScorableJob, profile: ScoringProfile): ScoreResult {
	const geo = geoFit(job.location, job.workplace_type, profile.remote_pref);
	const comp = compFit(job.salary_max, profile.salary_floor);
	const breakdown: ScoreBreakdown = {
		relevance: relevance(job.title, job.description, profile.keywords),
		level_match: levelMatch(job.role_level, profile.levels),
		geo_fit: geo.fit,
		comp_fit: comp.fit,
		stack_fit: stackFit(job.title, profile.stack),
		domain_interest: domainInterest(
			job.title,
			job.description,
			profile.interests_like,
			profile.interests_avoid
		),
		discipline_factor: classifyDiscipline(job.title) === 'adjacent' ? DISCIPLINE_PENALTY : 1.0,
	};
	return { score: compose(breakdown, geo.penalty * comp.penalty), breakdown };
}

/** Description-independent axis values plus bounds for the two description-
 *  dependent ones — the feed's light pass uses these both to shortlist for
 *  full scoring and to shortlist per-LENS (sort by comp/interest/relevance).
 *  `penalized` marks the multiplicative sinks (lowball comp, non-Americas
 *  remote, adjacent discipline) — lens views exclude those outright: they are
 *  exactly the owner's hard floors. */
export interface LightAxes {
	relevance_bound: number;
	level_match: number;
	geo_fit: number;
	comp_fit: number;
	stack_fit: number;
	interest_bound: number;
	discipline_factor: number;
	penalized: boolean;
	bound: number;
}

export function scoreJobLightAxes(job: ScorableJobLight, profile: ScoringProfile): LightAxes {
	const geo = geoFit(job.location, job.workplace_type, profile.remote_pref);
	const comp = compFit(job.salary_max, profile.salary_floor);
	const discipline = classifyDiscipline(job.title) === 'adjacent' ? DISCIPLINE_PENALTY : 1.0;
	const breakdown: ScoreBreakdown = {
		relevance: relevanceUpperBound(job.title, profile.keywords),
		level_match: levelMatch(job.role_level, profile.levels),
		geo_fit: geo.fit,
		comp_fit: comp.fit,
		stack_fit: stackFit(job.title, profile.stack),
		domain_interest: domainInterestUpperBound(
			job.title,
			profile.interests_like,
			profile.interests_avoid
		),
		discipline_factor: discipline,
	};
	return {
		relevance_bound: breakdown.relevance,
		level_match: breakdown.level_match,
		geo_fit: geo.fit,
		comp_fit: comp.fit,
		stack_fit: breakdown.stack_fit,
		interest_bound: breakdown.domain_interest,
		discipline_factor: discipline,
		penalized: geo.penalty < 1 || comp.penalty < 1 || discipline < 1,
		bound: compose(breakdown, geo.penalty * comp.penalty),
	};
}

/**
 * Optimistic upper bound WITHOUT the description — used by the feed's light
 * pass. Description-independent axes are exact; relevance and interest assume
 * best-case description content. A job excluded from the full-scoring
 * shortlist has a bound below the shortlist's floor, so it could never have
 * out-ranked the shortlist even with a perfect description.
 */
export function scoreJobUpperBound(job: ScorableJobLight, profile: ScoringProfile): number {
	return scoreJobLightAxes(job, profile).bound;
}
