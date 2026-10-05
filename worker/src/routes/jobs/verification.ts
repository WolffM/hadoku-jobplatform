/**
 * GET /verification-codes — the codes ATS boards emailed, for the owner to type.
 *
 * Greenhouse holds an application until a code it emails is typed into the
 * form. This lists the recent ones from the hadoku.me mail feed so the owner
 * reads them on the dashboard instead of in an inbox (2026-10-04).
 *
 * WHO MAY READ THEM: the mailbox owner, as a person, and nobody else.
 * - Admin tier only. The feed is the owner's mailbox; a friend-tier caller is
 *   someone else, and must not see another person's codes.
 * - Never a service identity, and never `ownerName`. The runner holds a
 *   service key; keeping codes out of its reach is what keeps this a display
 *   for a human rather than a pipeline that answers the board's check itself.
 *   docs/DECISION-mail-reconciler.md §1 explains why that line matters.
 *
 * Read live from the feed and never stored, like every other mail body.
 */
import type { JobsApp } from './shared.js';
import { fetchMessages, isFeedError } from '../../clients/mailfeed.js';
import { parseMail } from '../../mailMatch.js';
import { extractCode } from '../../verificationCode.js';

/** How far back to look. Codes expire within minutes; a few hours covers a session. */
const WINDOW_MS = 6 * 60 * 60 * 1000;

/** Enough of an unparseable mail for the owner to find the code by eye. */
const TEXT_LIMIT = 600;

export function registerVerificationRoutes(app: JobsApp) {
	app.get('/verification-codes', async (c) => {
		const auth = c.get('authContext');
		if (auth.userType !== 'admin' || !auth.credential) {
			return c.json(
				{
					success: false as const,
					error: 'Forbidden',
					message: 'Verification codes are shown to the mailbox owner only.',
				},
				403
			);
		}
		if (c.req.query('ownerName')) {
			return c.json(
				{
					success: false as const,
					error: 'Bad request',
					message: 'Verification codes cannot be read on behalf of anyone.',
				},
				400
			);
		}

		const since = new Date(Date.now() - WINDOW_MS).toISOString();
		const page = await fetchMessages(c.env, { since, limit: 100 });
		if (isFeedError(page)) {
			return c.json({ success: false as const, error: 'Upstream error', message: page.error }, 502);
		}

		const codes = page.messages
			.filter((m) => m.receivedAt >= Date.now() - WINDOW_MS)
			.map((m) => ({ m, parsed: parseMail(m.subject, m.fromDomain) }))
			.filter(({ parsed }) => parsed.kind === 'verification')
			.sort((a, b) => b.m.receivedAt - a.m.receivedAt)
			.map(({ m, parsed }) => {
				const code = extractCode(m.body);
				return {
					id: m.id,
					company: parsed.company,
					subject: m.subject,
					received_at: new Date(m.receivedAt).toISOString(),
					code,
					// Only when the code could not be picked out, so the owner can
					// still read it rather than being sent to the inbox anyway.
					text: code ? null : m.body.trim().slice(0, TEXT_LIMIT),
				};
			});

		return c.json({ success: true as const, data: { codes } }, 200);
	});
}
