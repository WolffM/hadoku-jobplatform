/**
 * ATS boards that hold only test postings, never real jobs.
 *
 * LinkedIn's own Greenhouse and Lever tenants (`linkedin`) are where LinkedIn
 * exercises its ATS integrations: "Bug Bash Job [No Sensitive Questions]",
 * "EA Test - Most Questions", "SJ_TEST_LEVER_ATTACHMENT", but also plausible
 * titles like "Software Engineer IV", "QA Engineer" and "Truck Driver - Hawai"
 * (all 76 rows in production on 2026-11-09, 53 Greenhouse + 23 Lever, read
 * one by one). LinkedIn posts its real jobs on its own careers site.
 *
 * Keyed on the BOARD, not the title: a title pattern narrow enough to spare
 * "Test Engineer" and "QA Engineer" elsewhere misses half of these, and one
 * wide enough to catch them all would catch real postings.
 */
import { parseAtsSlug } from './slugParse.js';

const TEST_BOARDS = new Set(['greenhouse:linkedin', 'lever:linkedin']);

/** The posting is on a known test board (by its URL, or the board the scraper says it fetched). */
export function isTestBoardPosting(
	url: string,
	scraped?: { ats?: string | null; slug?: string | null }
): boolean {
	const onTestBoard = (ats?: string | null, slug?: string | null) =>
		!!ats && !!slug && TEST_BOARDS.has(`${ats.toLowerCase()}:${slug.toLowerCase()}`);
	const parsed = parseAtsSlug(url);
	return onTestBoard(parsed.ats, parsed.slug) || onTestBoard(scraped?.ats, scraped?.slug);
}

/** For the migration and tests: the boards as (ats, slug) pairs. */
export const TEST_BOARD_PAIRS = [...TEST_BOARDS].map((k) => {
	const [ats, slug] = k.split(':');
	return { ats, slug };
});
