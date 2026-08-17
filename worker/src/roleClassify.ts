/**
 * Role classification — what KIND of job is this, and at what level?
 *
 * No ATS publishes this. Greenhouse gives us departments/offices/metadata,
 * Ashby gives department/team/employmentType, Lever gives categories.team +
 * commitment. None of them carry a level field or a "has direct reports" flag,
 * so both axes have to be inferred from the title, falling back to the
 * description body when the title is genuinely ambiguous.
 *
 * Two ORTHOGONAL axes, deliberately kept apart:
 *
 *   track — 'ic' | 'manager'. Does this job have direct reports?
 *   level — where it sits on its track's ladder. Each track has its own scale;
 *           a level value implies its track.
 *
 * The old single `role_types` list mixed the two ('senior' and 'manager' were
 * alternatives to each other), which made "senior OR manager" the only
 * expressible query and let a Senior Engineering Manager and a Senior Engineer
 * score identically.
 */

export type RoleTrack = 'ic' | 'manager' | 'unknown';

export const IC_LEVELS = ['junior', 'mid', 'senior', 'staff', 'principal', 'fellow'] as const;
export const MANAGER_LEVELS = ['manager', 'senior_manager', 'director', 'vp', 'cxo'] as const;

export type IcLevel = (typeof IC_LEVELS)[number];
export type ManagerLevel = (typeof MANAGER_LEVELS)[number];
export type RoleLevel = IcLevel | ManagerLevel;

export const ALL_LEVELS: readonly RoleLevel[] = [...IC_LEVELS, ...MANAGER_LEVELS];

export function levelTrack(level: RoleLevel): 'ic' | 'manager' {
	return (IC_LEVELS as readonly string[]).includes(level) ? 'ic' : 'manager';
}

/** Position on the level's own ladder — used for near-miss scoring. */
export function levelRank(level: RoleLevel): number {
	const ic = (IC_LEVELS as readonly string[]).indexOf(level);
	return ic >= 0 ? ic : (MANAGER_LEVELS as readonly string[]).indexOf(level);
}

export interface RoleClassification {
	track: RoleTrack;
	/** null when the title carries no level signal — scored as neutral, not as a miss. */
	level: RoleLevel | null;
}

/**
 * Discipline — is this an ENGINEERING seat at all?
 *
 * Track answers IC-vs-manager; it deliberately puts a Staff Product Manager on
 * the `ic` track, which is correct for track but means an engineering profile
 * could never exclude PM/design/sales roles — one topped the SWE feed at a
 * perfect 1.000. `eng` wins when both signals appear ("Product Engineer",
 * "Engineering Manager" are engineering; "Product Manager" is not), and titles
 * with neither signal stay `unknown` and are scored neutrally.
 */
export type RoleDiscipline = 'eng' | 'adjacent' | 'unknown';

const ENG_TITLE = new RegExp(
	'\\b(?:engineer(?:ing)?|developer|swe|sde|sre|devops|architect|scientist|' +
		'researcher|programmer|technician)\\b'
);

const ADJACENT_TITLE = new RegExp(
	[
		// product/program/project ladders (incl. TPM and "Product Owner")
		'\\b(?:technical\\s+)?(?:product|program|project)\\s+(?:manager|owner|lead|director)\\b',
		'\\btpm\\b',
		// design ladder
		'\\b(?:product\\s+|ux\\s+|ui\\s+|visual\\s+)?designer\\b|\\bux\\b|\\bdesign\\s+(?:lead|director)\\b',
		// go-to-market and business seats
		'\\b(?:marketing|sales|account\\s+(?:executive|manager)|partnerships?|business\\s+development)\\b',
		// people/talent/legal/finance/support ladders
		'\\b(?:recruiter|talent|people\\s+ops|human\\s+resources|counsel|legal|' +
			'accountant|controller|customer\\s+(?:success|support)|community)\\b',
		// analyst seats without an engineering qualifier
		'\\b(?:business|financial|data)\\s+analyst\\b',
	].join('|')
);

export function classifyDiscipline(title: string): RoleDiscipline {
	const t = title.toLowerCase();
	if (ENG_TITLE.test(t)) return 'eng';
	if (ADJACENT_TITLE.test(t)) return 'adjacent';
	return 'unknown';
}

// ── title patterns ──────────────────────────────────────────────────────────

// Titles that carry a management word but describe an individual contributor.
// This is the single biggest trap in title-based classification: a Technical
// Program Manager has no reports, and an Account Director is a seat on the
// sales ladder, not an org. Verified against the live corpus — "Account
// Director" alone accounted for ~17% of everything the first pass called a
// manager.
const IC_QUALIFIED_TITLE = new RegExp(
	[
		// "<qualifier> Manager"
		'\\b(?:product|program|project|technical program|account|community|' +
			'partner(?:ship)?|marketing|category|brand|portfolio|delivery|release|' +
			'customer success|social media|content)\\s+manager\\b',
		// "<qualifier> Director" — sales/partnerships ladders and board seats
		'\\b(?:account|partner|client|non[\\s-]?executive)\\s+director\\b',
	].join('|')
);

// A C-level token that belongs to the ORG, not the role: "…, Office of the
// CFO" describes who you'd support, not that you are one.
const CXO_AS_CONTEXT = /\b(?:office of|to the|reporting to|support(?:ing)? the)\b/;

// Explicit people-management titles, most senior first. Each maps to a rung on
// the manager ladder.
const MANAGER_TITLE_RULES: { pattern: RegExp; level: ManagerLevel }[] = [
	{ pattern: /\bc[teiofps]o\b|\bchief\b(?! of staff)/, level: 'cxo' },
	{ pattern: /\b(?:[se]?vp|vice president)\b/, level: 'vp' },
	{ pattern: /\bhead of\b/, level: 'vp' },
	{ pattern: /\b(?:senior|sr\.?|group)\s+director\b/, level: 'vp' },
	{ pattern: /\bdirector\b/, level: 'director' },
	{ pattern: /\b(?:senior|sr\.?|group)\s+(?:engineering\s+)?manager\b/, level: 'senior_manager' },
	{ pattern: /\bmanager\b/, level: 'manager' },
	{ pattern: /\bsupervisor\b/, level: 'manager' },
];

// IC ladder rungs, most senior first — first hit wins, so "Senior Staff
// Engineer" lands on staff rather than senior.
const IC_LEVEL_RULES: { pattern: RegExp; level: IcLevel }[] = [
	{ pattern: /\b(?:distinguished|fellow)\b/, level: 'fellow' },
	{ pattern: /\bprincipal\b/, level: 'principal' },
	// "Member of Technical Staff" is the base IC title at the AI labs (which are
	// most of the default profile's companies), not a staff-level rung — and a
	// "Chief of Staff" is neither staff nor C-level. Both are excluded here; the
	// chief case is also kept off the manager ladder below.
	{ pattern: /(?<!of )(?<!technical )\bstaff\b/, level: 'staff' },
	{ pattern: /\b(?:senior|sr\.?)\b/, level: 'senior' },
	{
		pattern: /\b(?:junior|jr\.?|intern|new\s+grad|graduate|entry[\s-]level|apprentice)\b/,
		level: 'junior',
	},
	{ pattern: /\bassociate\b/, level: 'junior' },
	// Roman numerals only — bare digits appear too often as noise ("Tier 3
	// Support", "2 openings") to be a reliable level signal.
	{ pattern: /\b(?:ii|iii)\b/, level: 'mid' },
	{ pattern: /\bi\b$/, level: 'junior' },
];

// Titles where the word carries no reliable signal either way — "Tech Lead" is
// an IC at Google/Meta, "Engineering Lead" often isn't. These fall through to
// the description probe instead of being guessed from the title.
const AMBIGUOUS_TITLE = /\b(?:lead|leader|leadership)\b/;

// "Tech Lead" specifically IS conventionally an IC, so it short-circuits the
// ambiguity — except "Tech Lead Manager" (Google's TLM), which really does
// carry reports and is caught by the manager rules before we get here.
const TECH_LEAD = /\b(?:tech|technical)\s+lead\b/;

// High-precision people-management signals in the description body. Only
// consulted when the title is ambiguous — an explicit IC title wins even if its
// body mentions mentoring, because senior IC postings always mention mentoring.
const REPORTS_SIGNALS: RegExp[] = [
	/\bdirect reports?\b/,
	/\bpeople manage(?:r|ment)\b/,
	/\bmanag(?:e|ing) a team of\b/,
	/\breport(?:s|ing) (?:in)?to you\b/,
	/\bperformance reviews?\b/,
	/\bmanage the (?:career|growth|performance)\b/,
	/\bhiring plan\b/,
	/\bheadcount\b/,
];

function normalize(s: string): string {
	return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The part of the title that names the ROLE, before any qualifier clause.
 *
 * Titles are overwhelmingly "«role», «team/region»" or "«role» - «team»", and
 * the tail routinely contains words that mean something else there: "Software
 * Engineer, Ads Manager" is an IC on the Ads Manager product, and "…Lead,
 * Office of the CFO" is not a C-level job. Scanning the head for the track
 * keeps a trailing product or org name from flipping it.
 */
function titleHead(title: string): string {
	const cut = title.search(/\s[,–—-]\s|,/);
	return cut > 0 ? title.slice(0, cut).trim() : title;
}

function icLevelFrom(title: string): IcLevel | null {
	for (const rule of IC_LEVEL_RULES) {
		if (rule.pattern.test(title)) return rule.level;
	}
	return null;
}

/**
 * Infer (track, level) for one job.
 *
 * Returns track 'unknown' only for an empty/blank title — every real title
 * resolves to ic or manager, since "no management evidence anywhere in the
 * title or the body" is itself sound evidence for IC.
 */
export function classifyRole(title: string, description = ''): RoleClassification {
	const t = normalize(title);
	if (!t) return { track: 'unknown', level: null };

	// Track is decided from the head of the title; level may legitimately appear
	// anywhere in it, so the level scan keeps the whole string.
	const head = titleHead(t);

	// 1. Explicit people-management title — unless it's one of the IC-qualified
	//    compounds (Product Manager, Account Director…), or the C-level token
	//    names the org this role supports rather than the role itself.
	if (!IC_QUALIFIED_TITLE.test(head)) {
		for (const rule of MANAGER_TITLE_RULES) {
			if (!rule.pattern.test(head)) continue;
			if (rule.level === 'cxo' && CXO_AS_CONTEXT.test(head)) break;
			return { track: 'manager', level: rule.level };
		}
	}

	// 2. IC by title, with whatever rung the title names.
	const icLevel = icLevelFrom(t);

	// 3. Ambiguous "lead"/"leader" titles get the description probe. A bare
	//    "Tech Lead" is conventionally an IC, so it skips the probe.
	if (AMBIGUOUS_TITLE.test(head) && !TECH_LEAD.test(head)) {
		const body = normalize(description);
		if (REPORTS_SIGNALS.some((re) => re.test(body))) {
			return { track: 'manager', level: 'manager' };
		}
	}

	return { track: 'ic', level: icLevel };
}
