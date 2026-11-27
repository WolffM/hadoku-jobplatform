/**
 * Company boards on the worker-pulled ATSes that are always in the plan,
 * whatever profiles subscribe to: a starter set of Berlin employers, so the
 * corpus has German coverage before anyone curates a company slice.
 *
 * Each was checked against its live feed on 2026-11-27 (open postings /
 * postings with a Berlin office at the time). Profiles add more the usual way,
 * POST /profiles/:id/companies with `ats` = `personio` or `smartrecruiters`;
 * plan.ts merges both lists.
 */
import type { SourceTask } from './types.js';

/** The ATS values this worker pulls itself. /directives withholds them from the scraper. */
export const WORKER_PULLED_ATS = ['personio', 'smartrecruiters'] as const;

export const STARTER_BOARDS: Exclude<SourceTask, { source: 'arbeitsagentur' }>[] = [
	// Personio: <slug>.jobs.personio.de
	{ source: 'personio', slug: '1komma5grad', company: '1KOMMA5°' }, // 347 / 90
	{ source: 'personio', slug: 'init-ag', company: ']init[ AG' }, // 209 / 45
	{ source: 'personio', slug: 'baupal-gmbh', company: 'Enter' }, // 22 / 22
	{ source: 'personio', slug: 'holy', company: 'HOLY' }, // 21 / 14
	{ source: 'personio', slug: 'govtech', company: 'GovTech Deutschland' }, // 13 / 13
	{ source: 'personio', slug: 'metergrid', company: 'metergrid' }, // 17 / 10
	{ source: 'personio', slug: 'voiio', company: 'voiio' }, // 8 / 8
	{ source: 'personio', slug: 'getquin', company: 'getquin' }, // 9 / 8
	{ source: 'personio', slug: 'merantix', company: 'Merantix' }, // 8 / 7
	{ source: 'personio', slug: 'personio', company: 'Personio' }, // 10 / 6
	{ source: 'personio', slug: 'good-hood-gmbh', company: 'nebenan.de' }, // 5 / 5
	{ source: 'personio', slug: 'vivid', company: 'Vivid Money' }, // 17 / 3
	{ source: 'personio', slug: 'thermondo', company: 'thermondo' }, // 198 / 3
	// SmartRecruiters, Germany only: these boards are global, and the German
	// slice is the part this list is for.
	{ source: 'smartrecruiters', company: 'Ramboll3', country: 'de' }, // 253 in DE / 19
	{ source: 'smartrecruiters', company: 'TurnerTownsend', country: 'de' }, // 80 in DE / 17
	{ source: 'smartrecruiters', company: 'Vattenfall', country: 'de' }, // 65 in DE / 21
	{ source: 'smartrecruiters', company: 'DeliveryHero', country: 'de' }, // 20 in DE / 20
];
