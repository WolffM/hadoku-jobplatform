/**
 * The code in an ATS verification mail, for the OWNER to read on the dashboard.
 *
 * Greenhouse holds an application until a code it emails is typed into the
 * form. The owner asked (2026-10-04) to read that code on the dashboard rather
 * than open an inbox — they own both the mail service and the dashboard — which
 * supersedes the "never displayed" line in docs/DECISION-mail-reconciler.md.
 * What still holds, and is enforced in routes/jobs/verification.ts: this route
 * gives the code to a signed-in human only, never a service identity.
 *
 * Since 2026-10-23 the scraper's apply runner also types the code for approved
 * Greenhouse rows, through its own mail-feed grant — not through here. Its
 * port of this file is hadoku-scraper's hadoku_scrape/apply/security_code.py;
 * keep the two in step.
 *
 * Two shapes are known. MyGreenhouse puts the code alone on a line between
 * rows of asterisks; application mails phrase it as "…code: XXXXXXXX" or put
 * it alone on a line after the sentence. Both are tried; when neither fits,
 * the caller shows the mail text instead of guessing.
 *
 * The feed delivers application mails as HTML, the code alone in an <h1>
 * (measured 2026-10-24), so the body is turned into text lines first.
 */

/** A token that looks like a one-time code: 6–12 letters/digits, one line. */
const TOKEN = /^[A-Za-z0-9]{6,12}$/;

/** Words that sit alone on a line in these mails and are not codes. */
const NOT_CODES = new Set(['greenhouse', 'security', 'application', 'regards', 'thanks']);

const HTML_TAG = /<[a-z!/][^>]*>/i;
const HTML_TAGS = /<[a-z!/][^>]*>/gi;
const HTML_UNSEEN = /<(head|style|script)\b[\s\S]*?<\/\1\s*>/gi;
const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	copy: '©',
};

/** `body` as text lines: an HTML mail with its tags turned into line breaks. */
export function mailText(body: string): string {
	if (!HTML_TAG.test(body)) return body;
	return body
		.replace(HTML_UNSEEN, '')
		.replace(HTML_TAGS, '\n')
		.replace(/&(#\d+|[a-z]+);/gi, (whole, name: string) =>
			name.startsWith('#')
				? String.fromCodePoint(Number(name.slice(1)))
				: (ENTITIES[name.toLowerCase()] ?? whole)
		);
}

export function extractCode(body: string): string | null {
	const lines = mailText(body)
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);

	// "…code is: ABCD1234" / "…code: ABCD1234" on one line.
	for (const line of lines) {
		const hit = /\bcode(?:\s+is)?\s*[:-]\s*([A-Za-z0-9]{6,12})\b/i.exec(line);
		if (hit?.[1]) return hit[1];
	}

	// Alone on its own line, framed by asterisk rows or following a sentence
	// that mentions the code. Must not be a plain word: real codes mix case or
	// carry a digit, and a lone "Greenhouse" line is a signature.
	const mentionsCode = (l: string) => /\bcode\b/i.test(l);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (!TOKEN.test(line) || NOT_CODES.has(line.toLowerCase())) continue;
		const framed = /^\*+$/.test(lines[i - 1] ?? '') && /^\*+$/.test(lines[i + 1] ?? '');
		const afterMention = lines.slice(Math.max(0, i - 3), i).some(mentionsCode);
		const codeLike = /\d/.test(line) || (/[a-z]/.test(line) && /[A-Z]/.test(line)) || framed;
		if ((framed || afterMention) && codeLike) return line;
	}
	return null;
}
