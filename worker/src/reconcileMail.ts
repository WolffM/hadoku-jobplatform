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

/** How far either side of a mail we will look for the application it names. */
const MATCH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Two mails naming one company inside this window are treated as possibly the
 * same application double-confirmed, rather than as two applications.
 *
 * The Pinecone pair sits 20.2 seconds apart with identical subjects and
 * byte-identical bodies naming no role, and the mail genuinely cannot say
 * whether that is two back-to-back applications or one double-send. Flagged
 * rather than guessed: inventing an application the owner never made is the
 * same phantom row this whole feature exists to eliminate.
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
	user_id: string;
	job_id: string;
	company: string;
	created_at: string;
	confirmed_at: string | null;
	verification_requested_at: string | null;
}

const STATE_LABEL = 'jobplatform';

/**
 * Walk the feed from the stored cursor and record what the mail says.
 *
 * `reset` starts from the beginning of the mailbox instead — the backfill. It
 * is the same loop and the same matching rules, which is the point: a separate
 * importer would be a second implementation of this function.
 */
export async function reconcileMail(
	env: AppEnv,
	opts: { reset?: boolean; maxPages?: number } = {}
): Promise<ReconcileReport | { error: string }> {
	const db = env.JOB_PLATFORM_DB;
	const warnings: string[] = [];

	const scope = await fetchScope(env);
	if (isFeedError(scope)) return scope;

	// A granted domain that has never delivered is worth saying out loud. This
	// is the check that would have caught `greenhouse.io` before it shipped.
	if (scope.senderDomains.length === 0) {
		warnings.push('the grant names no sender domains — every poll will look like silence');
	}

	const state = await db
		.prepare('SELECT cursor FROM mail_reconcile_state WHERE label = ?')
		.bind(STATE_LABEL)
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
			await applyMessage(db, message, report);
		}

		cursor = got.nextCursor;
		report.cursor = cursor;
		if (!cursor) break;
	}

	await db
		.prepare(
			`INSERT INTO mail_reconcile_state
			   (label, cursor, last_run_at, messages_seen, matched, unmatched)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (label) DO UPDATE SET
			   cursor = excluded.cursor,
			   last_run_at = excluded.last_run_at,
			   messages_seen = mail_reconcile_state.messages_seen + excluded.messages_seen,
			   matched = mail_reconcile_state.matched + excluded.matched,
			   unmatched = mail_reconcile_state.unmatched + excluded.unmatched`
		)
		.bind(
			STATE_LABEL,
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
	message: MailMessage,
	report: ReconcileReport
): Promise<void> {
	const parsed = parseMail(message.subject, message.fromDomain);
	const receivedAt = new Date(message.receivedAt).toISOString();

	// Account mail from an ATS is about the ATS, not about an application.
	// "Welcome to MyGreenhouse. Start your search." must never mark anything.
	if (parsed.kind === 'other' && !parsed.company) {
		report.ignored++;
		return;
	}
	if (!parsed.company) {
		// Recognised as an application mail but names no employer. Nothing to
		// attach it to, and attaching it to a guess is worse than recording it.
		await recordUnmatched(db, message, parsed.kind, null, receivedAt, null);
		report.unmatched++;
		return;
	}

	const candidates = await findCandidates(db, parsed.company, message.receivedAt);

	if (candidates.length === 0) {
		const duplicateOf = await findRecentUnmatched(db, parsed.company, message.receivedAt);
		if (duplicateOf) report.duplicatesFlagged++;
		await recordUnmatched(db, message, parsed.kind, parsed.company, receivedAt, duplicateOf);
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
				.prepare('UPDATE applications SET verification_requested_at = ? WHERE id = ?')
				.bind(receivedAt, row.id)
				.run();
		} else if (parsed.kind === 'confirmation') {
			await db
				.prepare('UPDATE applications SET confirmed_at = ?, confirmation_source = ? WHERE id = ?')
				.bind(receivedAt, message.fromDomain, row.id)
				.run();
		}
	}

	if (parsed.kind === 'verification') report.verificationFlagged++;
	else if (parsed.kind === 'confirmation') report.confirmed++;
	else report.ignored++;
}

/** Applications to this employer within the match window of the mail. */
async function findCandidates(
	db: AppEnv['JOB_PLATFORM_DB'],
	company: string,
	receivedAtMs: number
): Promise<AppRow[]> {
	const from = new Date(receivedAtMs - MATCH_WINDOW_MS).toISOString();
	const to = new Date(receivedAtMs + MATCH_WINDOW_MS).toISOString();
	const res = await db
		.prepare(
			`SELECT a.id, a.user_id, a.job_id, j.company, a.created_at,
			        a.confirmed_at, a.verification_requested_at
			 FROM applications a
			 INNER JOIN jobs j ON j.id = a.job_id
			 WHERE a.created_at BETWEEN ? AND ?`
		)
		.bind(from, to)
		.all<AppRow>();
	// Company comparison in JS rather than SQL: the normalisation strips
	// punctuation and suffixes, which SQLite cannot express without a UDF.
	return res.results.filter((r) => companiesMatch(company, r.company));
}

/** A mail for this company already recorded unmatched, close enough in time. */
async function findRecentUnmatched(
	db: AppEnv['JOB_PLATFORM_DB'],
	company: string,
	receivedAtMs: number
): Promise<string | null> {
	const from = new Date(receivedAtMs - DUPLICATE_WINDOW_MS).toISOString();
	const to = new Date(receivedAtMs + DUPLICATE_WINDOW_MS).toISOString();
	const row = await db
		.prepare(
			`SELECT message_id FROM mail_unmatched
			 WHERE company = ? AND received_at BETWEEN ? AND ?
			 ORDER BY received_at ASC LIMIT 1`
		)
		.bind(company, from, to)
		.first<{ message_id: string }>();
	return row?.message_id ?? null;
}

async function recordUnmatched(
	db: AppEnv['JOB_PLATFORM_DB'],
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
			   (message_id, received_at, from_domain, subject, company, kind,
			    possible_duplicate_of, seen_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (message_id) DO NOTHING`
		)
		.bind(
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
