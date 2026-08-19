/**
 * Pull an annual USD salary range out of job-description PROSE.
 *
 * ~90% of postings have NULL structured salary columns, but US pay-transparency
 * laws push boards to state the range in the description ("The base salary
 * range is 272,000 USD - 431,250 USD"). Missing those made the comp axis blind
 * on exactly the postings the owner cares about.
 *
 * Conservative by design: only $-or-USD-marked amounts, only annual magnitudes,
 * skip ranges whose immediate context says hourly/monthly. When a description
 * lists several ranges (location-tiered), take the overall min and max — comp
 * scoring wants the best case the posting admits to.
 */

export interface ParsedSalary {
	min: number;
	max: number;
}

// "$272,000", "272,000 USD", "$150k", "150K USD" — an amount only counts when a
// currency marker touches it, so bare numbers ("13,000 repositories") never match.
const AMOUNT = String.raw`(?:\$\s*(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d+)?[kK])|(\d{2,3}(?:,\d{3})+|\d{2,3}(?:\.\d+)?[kK])\s*(?=USD))`;
const RANGE_RE = new RegExp(`${AMOUNT}(?:\\s*USD)?\\s*(?:[-–—]|to)\\s*${AMOUNT}(?:\\s*USD)?`, 'g');

const NON_ANNUAL_CONTEXT =
	/(?:per\s+hour|hourly|\/\s*(?:hr|hour)|per\s+month|monthly|per\s+week|weekly|per\s+day)/i;

const MIN_ANNUAL = 40_000;
const MAX_ANNUAL = 2_000_000;

function toNumber(raw: string): number {
	const s = raw.trim();
	if (/[kK]$/.test(s)) return Math.round(parseFloat(s) * 1000);
	return Number(s.replace(/,/g, ''));
}

export function parseSalaryRange(text: string): ParsedSalary | null {
	if (!text) return null;
	let best: ParsedSalary | null = null;
	for (const m of text.matchAll(RANGE_RE)) {
		// Two capture alternatives per amount ($-prefixed vs USD-suffixed).
		const lo = toNumber(m[1] ?? m[2] ?? '');
		const hi = toNumber(m[3] ?? m[4] ?? '');
		if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) continue;
		if (lo < MIN_ANNUAL || hi > MAX_ANNUAL) continue;
		// Peek around the match for a non-annual unit before trusting it.
		const start = Math.max(0, (m.index ?? 0) - 40);
		const context = text.slice(start, (m.index ?? 0) + m[0].length + 40);
		if (NON_ANNUAL_CONTEXT.test(context)) continue;
		best = best
			? { min: Math.min(best.min, lo), max: Math.max(best.max, hi) }
			: { min: lo, max: hi };
	}
	return best;
}
