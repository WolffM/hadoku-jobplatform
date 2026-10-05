/**
 * The code in an ATS verification mail, for the OWNER to read on the dashboard.
 *
 * Greenhouse holds an application until a code it emails is typed into the
 * form. The owner asked (2026-10-04) to read that code on the dashboard rather
 * than open an inbox — they own both the mail service and the dashboard — which
 * supersedes the "never displayed" line in docs/DECISION-mail-reconciler.md.
 * What still holds, and is enforced in routes/jobs/verification.ts: the code
 * reaches a signed-in human only. No service identity (the runner) can fetch
 * it, and nothing types it into a form; the owner does.
 *
 * Two shapes are known. MyGreenhouse puts the code alone on a line between
 * rows of asterisks; application mails phrase it as "…code: XXXXXXXX" or put
 * it alone on a line after the sentence. Both are tried; when neither fits,
 * the caller shows the mail text instead of guessing.
 */

/** A token that looks like a one-time code: 6–12 letters/digits, one line. */
const TOKEN = /^[A-Za-z0-9]{6,12}$/;

/** Words that sit alone on a line in these mails and are not codes. */
const NOT_CODES = new Set(['greenhouse', 'security', 'application', 'regards', 'thanks']);

export function extractCode(body: string): string | null {
	const lines = body
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
