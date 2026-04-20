export interface ScoreBreakdown {
	title_match: number;
	keyword_match: number;
	company_boost: number;
	seniority_match: number;
	remote_match: number;
	salary_match: number;
}

export interface ScoreResult {
	score: number;
	breakdown: ScoreBreakdown;
}

// Keywords that signal seniority — matched against job title
const SENIORITY_KEYWORDS: Record<string, string[]> = {
	SENIOR: ['senior', 'sr.', 'sr '],
	STAFF: ['staff'],
	PRINCIPAL: ['principal'],
	LEAD: ['lead', 'tech lead', 'technical lead'],
	MANAGER: ['manager', 'engineering manager', 'em '],
	DIRECTOR: ['director'],
	EXECUTIVE: ['vp ', 'vice president', 'cto', 'chief'],
};

function countKeywordMatches(text: string, keywords: string[]): number {
	if (!keywords.length) return 0;
	const lower = text.toLowerCase();
	return keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
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

function companyBoost(company: string, targetCompanies: string[]): number {
	if (!targetCompanies.length) return 0.5; // no preference
	const lower = company.toLowerCase();
	const hit = targetCompanies.some(
		(tc) => lower.includes(tc.toLowerCase()) || tc.toLowerCase().includes(lower)
	);
	return hit ? 1.0 : 0.3;
}

function seniorityMatch(title: string, roleTypes: string[]): number {
	if (!roleTypes.length) return 0.5;
	const lower = title.toLowerCase();
	const hit = roleTypes.some((rt) => {
		const patterns = SENIORITY_KEYWORDS[rt.toUpperCase()] ?? [rt.toLowerCase()];
		return patterns.some((p) => lower.includes(p));
	});
	return hit ? 1.0 : 0.4;
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

function salaryMatch(salaryMin: number | null, profileMinSalary: number | null): number {
	if (salaryMin === null || profileMinSalary === null) return 0.5; // missing data, neutral
	if (salaryMin >= profileMinSalary) return 1.0;
	const floor = profileMinSalary * 0.75;
	if (salaryMin <= floor) return 0.0;
	return (salaryMin - floor) / (profileMinSalary - floor);
}

export function scoreJob(
	job: {
		title: string;
		description: string;
		company: string;
		workplace_type: string;
		salary_min: number | null;
	},
	profile: {
		keywords: string[];
		target_companies: string[];
		role_types: string[];
		remote_pref: string;
		min_salary: number | null;
	}
): ScoreResult {
	const breakdown: ScoreBreakdown = {
		title_match: titleMatch(job.title, profile.keywords),
		keyword_match: keywordMatch(job.description, profile.keywords),
		company_boost: companyBoost(job.company, profile.target_companies),
		seniority_match: seniorityMatch(job.title, profile.role_types),
		remote_match: remoteMatch(job.workplace_type, profile.remote_pref),
		salary_match: salaryMatch(job.salary_min, profile.min_salary),
	};

	const score =
		breakdown.title_match * 0.25 +
		breakdown.keyword_match * 0.35 +
		breakdown.company_boost * 0.15 +
		breakdown.seniority_match * 0.1 +
		breakdown.remote_match * 0.1 +
		breakdown.salary_match * 0.05;

	return { score: Math.round(score * 1000) / 1000, breakdown };
}
