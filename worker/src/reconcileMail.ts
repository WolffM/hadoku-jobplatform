/**
 * Reconciling the mailbox against the application queue.
 *
 * The queue is the runner's account of what it did. The mailbox is the
 * employer's. This walks the second and records where it disagrees with the
 * first — it never overwrites `status`, because the disagreement IS the
 * product. On 2026-09-19 the queue reported zero applications sent while a
 * Pinecone confirmation sat unread for an application it had no row for.
 *
 * Direction: the inbox is the master list, the queue is reconciled AGAINST it.
 *
 * SCOPED TO ONE OWNER, ALWAYS. Mail to matthaeus@hadoku.me is evidence about
 * his applications and nobody else's. The first production run matched with no
 * user filter and reported `confirmed: 2` for Pinecone against an owner with no
 * Pinecone application — it had reached another identity's rows. An unscoped
 * match writes a confirmation onto a row the mail says nothing about, which is
 * the fabricated-evidence failure this whole feature exists to prevent.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * Verification codes are 4 of the 7 messages currently in scope and their
 * values are in bodies this code receives. A code mail sets state; its contents
 * are never parsed, stored, logged or displayed. See
 * docs/DECISION-mail-reconciler.md — the short version is that the dashboard is
 * one click from a runner whose whole job is typing values into ATS forms, and
 * not holding the value is the version of that boundary which cannot rot.
 */

import type { AppEnv } from './types.js';
import { fetchMessages, fetchScope, isFeedError, type MailMessage } from './clients/mailfeed.js';
import { companiesMatch, parseMail } from './mailMatch.js';

/**
 * How long before a mail an application may have been created and still be the
 * one it refers to.
 *
 * Generous on purpose. `created_at` is when the row was QUEUED, which on this
 * pipeline is routinely weeks before anything is submitted — the Coinbase rows
 * were queued on 2026-09-09 and drew their security codes on 2026-09-16. A
 * tight window silently finds nothing, and "no candidates" is indistinguishable
 * from "no such application".
 */
const MATCH_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * How far AFTER a mail an application may have been created and still match.
 *
 * Small, and not zero only to absorb clock skew between D1 and the mail host.
 * An employer cannot acknowledge an application that does not exist yet, so
 * this bound is the one doing real work: it stops a confirmation attaching to
 * an application queued later to the same company.
 */
const MATCH_SKEW_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Two mails naming one company inside this window may be the same application
 * confirmed twice rather than two applications.
 *
 * The Pinecone pair sits 20.2 seconds apart with identical subjects and
 * byte-identical bodies naming no role, and the mail genuinely cannot say
 * which it is. Flagged rather than guessed: inventing an application the owner
 * never made is the same phantom row this feature exists to eliminate.
 */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export interface ReconcileReport {
	scopeLabel: string;
	scopeDomains: number;
	messagesSeen: number;
	confirmed: number;
	verificationFlagged: number;
	unmatched: number;
	duplicatesFlagged: number;
	ignored: number;
	cursor: string | null;
	warnings: string[];
}

interface AppRow {
	id: string;
	job_id: string;
	company: string;
	created_at: string;
}

export async function reconcileMail(
	env: AppEnv,
	userId: string,
	opts: { reset?: boolean; maxPages?: number } = {}
): Promise<ReconcileReport | { error: string }> {
	const db = env.JOB_PLATFORM_DB;
	const warnings: string[] = [];

	const scope = await fetchScope(env);
	if (isFeedError(scope)) return scope;

	if (scope.senderDomains.length === 0) {
		warnings.push('the grant names no sender domains — every poll will look like silence');
	}

	const state = await db
		.prepare('SELECT cursor FROM mail_reconcile_state WHERE user_id = ?')
		.bind(userId)
		.first<{ cursor: string | null }>();

	let cursor = opts.reset ? null : (state?.cursor ?? null);
	const report: ReconcileReport = {
		scopeLabel: scope.label,
		scopeDomains: scope.senderDomains.length,
		messagesSeen: 0,
		confirmed: 0,
		verificationFlagged: 0,
		unmatched: 0,
		duplicatesFlagged: 0,
		ignored: 0,
		cursor,
		warnings,
	};

	const maxPages = opts.maxPages ?? 20;
	for (let page = 0; page < maxPages; page++) {
		const got = await fetchMessages(env, { cursor });
		if (isFeedError(got)) return got;
		if (got.messages.length === 0) break;

		for (const message of got.messages) {
			report.messagesSeen++;
			await applyMessage(db, userId, message, report);
		}

		cursor = got.nextCursor;
		report.cursor = cursor;
		if (!cursor) break;
	}

	await db
		.prepare(
			`INSERT INTO mail_reconcile_state
			   (user_id, cursor, last_run_at, messages_seen, matched, unmatched)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (user_id) DO UPDATE SET
			   cursor = excluded.cursor,
			   last_run_at = excluded.last_run_at,
			   messages_seen = excluded.messages_seen,
			   matched = excluded.matched,
			   unmatched = excluded.unmatched`
		)
		.bind(
			userId,
			cursor,
			new Date().toISOString(),
			report.messagesSeen,
			report.confirmed + report.verificationFlagged,
			report.unmatched
		)
		.run();

	return report;
}

async function applyMessage(
	db: AppEnv['JOB_PLATFORM_DB'],
	userId: string,
	message: MailMessage,
	report: ReconcileReport
): Promise<void> {
	const parsed = parseMail(message.subject, message.fromDomain);
	const receivedAt = new Date(message.receivedAt).toISOString();

	if (parsed.kind === 'other' && !parsed.company) {
		report.ignored++;
		return;
	}
	if (!parsed.company) {
		await recordUnmatched(db, userId, message, parsed.kind, null, receivedAt, null);
		report.unmatched++;
		return;
	}

	const candidates = await findCandidates(db, userId, parsed.company, message.receivedAt);

	if (candidates.length === 0) {
		const duplicateOf = await findRecentUnmatched(db, userId, parsed.company, message);
		if (duplicateOf) report.duplicatesFlagged++;
		await recordUnmatched(
			db,
			userId,
			message,
			parsed.kind,
			parsed.company,
			receivedAt,
			duplicateOf
		);
		report.unmatched++;
		return;
	}

	// The mail names a company and frequently no role — measured: neither
	// Pinecone confirmation names one — so a single mail can legitimately
	// correspond to any of several applications to that employer. Mark them all
	// rather than picking one arbitrarily: "an application to Datadog was
	// confirmed" is true of each, and a wrong single pick would be a fact
	// nobody can later audit.
	for (const row of candidates) {
		if (parsed.kind === 'verification') {
			await db
				.prepare(
					'UPDATE applications SET verification_requested_at = ? WHERE id = ? AND user_id = ?'
				)
				.bind(receivedAt, row.id, userId)
				.run();
		} else if (parsed.kind === 'confirmation') {
			await db
				.prepare(
					`UPDATE applications SET confirmed_at = ?, confirmation_source = ?
					 WHERE id = ? AND user_id = ?`
				)
				.bind(receivedAt, message.fromDomain, row.id, userId)
				.run();
		}
	}

	if (parsed.kind === 'verification') report.verificationFlagged++;
	else if (parsed.kind === 'confirmation') report.confirmed++;
	else report.ignored++;
}

/** This owner's applications to this employer that could be what the mail means. */
async function findCandidates(
	db: AppEnv['JOB_PLATFORM_DB'],
	userId: string,
	company: string,
	receivedAtMs: number
): Promise<AppRow[]> {
	const from = new Date(receivedAtMs - MATCH_LOOKBACK_MS).toISOString();
	const to = new Date(receivedAtMs + MATCH_SKEW_MS).toISOString();
	const res = await db
		.prepare(
			`SELECT a.id, a.job_id, j.company, a.created_at
			 FROM applications a
			 INNER JOIN jobs j ON j.id = a.job_id
			 WHERE a.user_id = ? AND a.created_at BETWEEN ? AND ?`
		)
		.bind(userId, from, to)
		.all<AppRow>();
	// Company comparison in JS rather than SQL: the normalisation strips
	// punctuation and suffixes, which SQLite cannot express without a UDF.
	return res.results.filter((r) => companiesMatch(company, r.company));
}

/**
 * An earlier mail for this company, close enough in time to be the same event.
 *
 * Excludes the message itself. Without that, a re-run makes every unmatched
 * mail a duplicate of the row IT wrote on the previous run — the first
 * production backfill reported `duplicates_flagged: 3` for a mailbox holding
 * exactly one genuine pair, because a second pass found each message's own
 * record sitting in the window.
 *
 * Ordered by `received_at` so the flag always points at the EARLIER mail,
 * making the pair a chain with a head rather than two rows pointing at
 * each other.
 */
async function findRecentUnmatched(
	db: AppEnv['JOB_PLATFORM_DB'],
	userId: string,
	company: string,
	message: MailMessage
): Promise<string | null> {
	const from = new Date(message.receivedAt - DUPLICATE_WINDOW_MS).toISOString();
	const to = new Date(message.receivedAt + DUPLICATE_WINDOW_MS).toISOString();
	const row = await db
		.prepare(
			`SELECT message_id FROM mail_unmatched
			 WHERE user_id = ? AND company = ? AND message_id != ?
			   AND received_at BETWEEN ? AND ?
			 ORDER BY received_at ASC LIMIT 1`
		)
		.bind(userId, company, message.id, from, to)
		.first<{ message_id: string }>();
	return row?.message_id ?? null;
}

async function recordUnmatched(
	db: AppEnv['JOB_PLATFORM_DB'],
	userId: string,
	message: MailMessage,
	kind: string,
	company: string | null,
	receivedAt: string,
	duplicateOf: string | null
): Promise<void> {
	// Subject and sender only. The body is never written down — see the module
	// header and docs/DECISION-mail-reconciler.md.
	await db
		.prepare(
			`INSERT INTO mail_unmatched
			   (user_id, message_id, received_at, from_domain, subject, company, kind,
			    possible_duplicate_of, seen_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (user_id, message_id) DO UPDATE SET
			   possible_duplicate_of = excluded.possible_duplicate_of`
		)
		.bind(
			userId,
			message.id,
			receivedAt,
			message.fromDomain,
			message.subject,
			company,
			kind,
			duplicateOf,
			new Date().toISOString()
		)
		.run();
}

export interface ReconcileView {
	lastRunAt: string | null;
	cursor: string | null;
	unmatched: {
		message_id: string;
		received_at: string;
		from_domain: string;
		subject: string;
		company: string | null;
		kind: string;
		possible_duplicate_of: string | null;
	}[];
	applications: {
		job_id: string;
		company: string;
		status: string;
		confirmed_at: string | null;
		confirmation_source: string | null;
		verification_requested_at: string | null;
	}[];
}

/**
 * What reconciliation currently says, for one owner.
 *
 * This exists because the first version shipped a writer with no reader: the
 * results landed in D1 where neither the owner nor anyone else could see them,
 * which for a feature whose entire purpose is making a disagreement VISIBLE is
 * a failure to deliver it at all.
 */
export async function reconcileView(env: AppEnv, userId: string): Promise<ReconcileView> {
	const db = env.JOB_PLATFORM_DB;
	const [state, unmatched, applications] = await db.batch<Record<string, unknown>>([
		db
			.prepare('SELECT cursor, last_run_at FROM mail_reconcile_state WHERE user_id = ?')
			.bind(userId),
		db
			.prepare(
				`SELECT message_id, received_at, from_domain, subject, company, kind,
				        possible_duplicate_of
				 FROM mail_unmatched WHERE user_id = ? ORDER BY received_at DESC`
			)
			.bind(userId),
		db
			.prepare(
				`SELECT a.job_id, j.company, a.status, a.confirmed_at, a.confirmation_source,
				        a.verification_requested_at
				 FROM applications a
				 INNER JOIN jobs j ON j.id = a.job_id
				 WHERE a.user_id = ?
				   AND (a.confirmed_at IS NOT NULL OR a.verification_requested_at IS NOT NULL)
				 ORDER BY COALESCE(a.confirmed_at, a.verification_requested_at) DESC`
			)
			.bind(userId),
	]);
	const stateRow = state.results[0] as { cursor: string | null; last_run_at: string } | undefined;
	return {
		lastRunAt: stateRow?.last_run_at ?? null,
		cursor: stateRow?.cursor ?? null,
		unmatched: unmatched.results as unknown as ReconcileView['unmatched'],
		applications: applications.results as unknown as ReconcileView['applications'],
	};
}
