/**
 * Every foreign key must be index-backed on the CHILD side.
 *
 * SQLite indexes the parent end of a foreign key (it is a primary key) but
 * never the child end, and every DELETE of a parent row runs
 * `SELECT ... FROM child WHERE fk_col = ?` to cascade or check it. With no
 * index leading on fk_col that is a full scan of the child table per deleted
 * parent row.
 *
 * That is what took ingest down 2026-10-17..19: job_profile_rank's primary key
 * leads with profile_id, so each job the cull deleted scanned all ~230k rank
 * rows. 500 per cull call ran into D1's 30s statement limit, and while those
 * statements held the single-threaded database every other ingest batch was
 * refused in ~20ms — 2,571 of 2,601 batches over three nights. It cost nothing
 * until 2026-10-16, when postings first got old enough to cull, so the gap sat
 * invisible from 0020 until it was fatal. 0027 fixed that table; this keeps
 * the next child table from repeating it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.ts';

let h: Harness;

before(async () => {
	h = await createHarness();
});

after(async () => {
	await h.dispose();
});

describe('schema: foreign keys', () => {
	it('every foreign key has an index leading on its child column', async () => {
		// D1 refuses pragma_foreign_key_list (SQLITE_AUTH), so read them from the
		// DDL: both the table-constraint and the inline column form.
		const tables = await h.db
			.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL")
			.all<{ name: string; sql: string }>();
		const fks: { child: string; col: string; parent: string }[] = [];
		for (const t of tables.results) {
			for (const m of t.sql.matchAll(/FOREIGN KEY\s*\(\s*(\w+)\s*\)\s*REFERENCES\s+(\w+)/gi)) {
				fks.push({ child: t.name, col: m[1], parent: m[2] });
			}
			for (const m of t.sql.matchAll(/^\s*(\w+)\s+\w+[^,\n]*?\bREFERENCES\s+(\w+)/gim)) {
				if (m[1].toUpperCase() !== 'FOREIGN') fks.push({ child: t.name, col: m[1], parent: m[2] });
			}
		}
		assert.ok(fks.length > 0, 'expected the schema to declare foreign keys');

		const unindexed = [];
		for (const fk of fks) {
			// The cascade's own lookup, planned the way SQLite will run it.
			const plan = await h.db
				.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM "${fk.child}" WHERE "${fk.col}" = ?`)
				.bind('x')
				.all<{ detail: string }>();
			const details = plan.results.map((r) => r.detail).join('; ');
			// Only a SEARCH on the column is a seek. "USING INDEX" alone is not:
			// without 0027 this read `SCAN job_profile_rank USING COVERING INDEX
			// sqlite_autoindex_job_profile_rank_1`, a full walk of the primary key.
			if (!new RegExp(`^SEARCH .*\\(${fk.col}=\\?`).test(details)) {
				unindexed.push(`${fk.child}.${fk.col} -> ${fk.parent}: ${details}`);
			}
		}
		assert.deepEqual(
			unindexed,
			[],
			'deleting a parent row scans these child tables once per row; add an index leading on the column'
		);
	});
});
