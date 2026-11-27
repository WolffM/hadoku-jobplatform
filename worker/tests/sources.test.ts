/**
 * The pulled job sources' adapters, over responses recorded from the real
 * endpoints (tests/fixtures/sources, saved 2026-11-27).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as arbeitsagentur from '../src/sources/arbeitsagentur.ts';
import * as personio from '../src/sources/personio.ts';
import * as smartrecruiters from '../src/sources/smartrecruiters.ts';
import { pooled } from '../src/sources/http.ts';
import { SourceFetchError, type HttpFetch } from '../src/sources/types.ts';
import { geoKeys } from '../src/geo.ts';
import { classifyRole } from '../src/roleClassify.ts';
import { fixture, fixtureJson } from './helpers/jobSources.ts';

type Search = { ergebnisliste: arbeitsagentur.JobsucheListing[]; maxErgebnisse: number };
const search = () => fixtureJson<Search>('arbeitsagentur-search.json');

/** A fetch that answers from a table and records each request. */
function fakeHttp(answer: (url: string) => { status?: number; body: string }) {
	const calls: { url: string; headers: Headers }[] = [];
	const http: HttpFetch = async (url, init) => {
		calls.push({ url, headers: new Headers(init?.headers) });
		const a = answer(url);
		return new Response(a.body, { status: a.status ?? 200 });
	};
	return { http, calls };
}

describe('arbeitsagentur (Jobsuche API)', () => {
	const task = {
		source: 'arbeitsagentur' as const,
		keyword: 'project manager',
		where: 'Berlin',
		radius_km: 40,
	};

	it('builds the documented search: employment only, no agencies or temp staffing, 30 days', () => {
		const u = new URL(arbeitsagentur.searchUrl(task, 2, { http: fetch }));
		assert.equal(
			u.origin + u.pathname,
			'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs'
		);
		assert.equal(u.searchParams.get('was'), 'project manager');
		assert.equal(u.searchParams.get('wo'), 'Berlin');
		assert.equal(u.searchParams.get('umkreis'), '40');
		assert.equal(u.searchParams.get('angebotsart'), '1');
		assert.equal(u.searchParams.get('pav'), 'false');
		assert.equal(u.searchParams.get('zeitarbeit'), 'false');
		assert.equal(u.searchParams.get('veroeffentlichtseit'), '30');
		assert.equal(u.searchParams.get('size'), '100');
		assert.equal(u.searchParams.get('page'), '2');
	});

	it('addresses a detail by the base64 of its reference number', () => {
		assert.equal(
			arbeitsagentur.detailUrl('15933-0065990738-S', { http: fetch }),
			'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/MTU5MzMtMDA2NTk5MDczOC1T'
		);
	});

	it('normalizes a recorded result into an ingest posting placed in Berlin', () => {
		const job = arbeitsagentur.normalizeListing(search().ergebnisliste[0]);
		assert.equal(job.id, 'arbeitsagentur_15933-0065990738-S');
		assert.equal(job.url, 'https://www.arbeitsagentur.de/jobsuche/jobdetail/15933-0065990738-S');
		assert.equal(job.source_site, 'arbeitsagentur.de');
		assert.equal(job.title, 'Senior Project Manager (m/w/d)');
		assert.equal(job.company, 'D-TRUST GmbH');
		assert.equal(job.location, 'Berlin, Deutschland');
		assert.equal(geoKeys(job.location), '|berlin-de|');
		assert.equal(job.job_type, 'full_time');
		assert.equal(job.workplace_type, 'unknown');
		assert.equal(job.salary, null, 'KEINE_ANGABEN is no salary');
		assert.equal(job.posted_date, '2026-07-10T00:00:00Z');
		assert.equal(job.application_url, job.url, 'no external URL: apply on the posting page');
		assert.equal(job.description, '', 'search results carry no text');
		assert.equal(
			classifyRole(job.title, '').track,
			'ic',
			'a PM title classifies like a scraped one'
		);
	});

	it('keeps an annual range as salary, and nothing else', () => {
		const base = search().ergebnisliste[0];
		// Constructed from the recorded row: the fields as the API words a range.
		const annual = arbeitsagentur.normalizeListing({
			...base,
			verguetungsangabe: 'JAHRESGEHALT',
			gehaltsspanneVon: 50000,
			gehaltsspanneBis: 75000,
			homeofficemoeglich: true,
			externeURL: 'https://careers.example/job/1',
		});
		assert.deepEqual(annual.salary, {
			min: 50000,
			max: 75000,
			currency: 'EUR',
			period: 'year',
			text: null,
		});
		assert.equal(annual.workplace_type, 'hybrid');
		assert.equal(annual.application_url, 'https://careers.example/job/1');
		const hourly = arbeitsagentur.normalizeListing({
			...base,
			verguetungsangabe: 'STUNDENLOHN',
			gehaltsspanneVon: 18,
		});
		assert.equal(hourly.salary, null);
	});

	it('joins several places and skips a place-less entry', () => {
		assert.equal(
			arbeitsagentur.locationText([
				{ adresse: { ort: 'Berlin', land: 'DEUTSCHLAND' } },
				{ adresse: { ort: 'Potsdam', land: 'DEUTSCHLAND' } },
				{ adresse: { ort: 'Berlin', land: 'DEUTSCHLAND' } },
				{},
			]),
			'Berlin, Deutschland | Potsdam, Deutschland'
		);
	});

	it('fills the description from the recorded detail', () => {
		const job = arbeitsagentur.normalizeListing(search().ergebnisliste[0]);
		const detail = fixtureJson<arbeitsagentur.JobsucheDetail>('arbeitsagentur-detail.json');
		const full = arbeitsagentur.withDetail(job, detail);
		assert.ok(full.description.length > 100);
		assert.equal(full.description, (detail.stellenangebotsBeschreibung as string).trim());
		assert.equal(arbeitsagentur.withDetail(job, {}).description, '');
	});

	it('lists with the public client id and stops at the last page', async () => {
		const { http, calls } = fakeHttp(() => ({ body: fixture('arbeitsagentur-search.json') }));
		const listings = await arbeitsagentur.list(task, { http });
		assert.equal(calls.length, 1, '3 results is under one page');
		assert.equal(calls[0].headers.get('X-API-Key'), 'jobboerse-jobsuche');
		assert.match(calls[0].headers.get('User-Agent') ?? '', /hadoku-jobplatform/);
		assert.equal(listings.length, 3);
		assert.ok(listings.every((l) => l.detailUrl?.includes('/pc/v4/jobdetails/')));
	});

	it('reads a second page only while the total says there is one', async () => {
		const row = search().ergebnisliste[0];
		const page = (n: number) =>
			JSON.stringify({
				maxErgebnisse: 150,
				ergebnisliste: Array.from({ length: n }, (_, i) => ({
					...row,
					referenznummer: `${n}-${i}`,
				})),
			});
		const { http, calls } = fakeHttp((url) => ({
			body: new URL(url).searchParams.get('page') === '1' ? page(100) : page(50),
		}));
		const listings = await arbeitsagentur.list(task, { http });
		assert.equal(calls.length, 2);
		assert.equal(listings.length, 150);
	});

	it('reports an HTTP error as a SourceFetchError with its status', async () => {
		const { http } = fakeHttp(() => ({ status: 403, body: '' }));
		await assert.rejects(arbeitsagentur.list(task, { http }), (err: unknown) => {
			assert.ok(err instanceof SourceFetchError);
			assert.equal(err.status, 403);
			return true;
		});
	});
});

describe('personio (XML feed)', () => {
	const task = { source: 'personio' as const, slug: 'merantix', company: 'Merantix' };
	// personio-feed.xml: two voiio positions (German board, German text) and
	// two Merantix positions, which the default feed sends without text because
	// they exist only in English; personio-feed-en.xml has those two in English.
	const defaultFeed = () => personio.parseFeed(fixture('personio-feed.xml'));

	it('reads every position, and the position name rather than a section name', () => {
		const positions = defaultFeed();
		assert.equal(positions.length, 4);
		assert.deepEqual(
			positions.map((p) => p.name),
			[
				'Account Executive (gn)',
				'Initiativbewerbung / Bewerbung für Talent Pool – Social Impact & Startup Growth (gn)',
				'Co-founder & CTO (Stealth AI Infrastructure for Physical Commodity Trading Venture)',
				'Founders Associate Intern (Stealth Start-up)',
			]
		);
		assert.deepEqual(positions[2].offices, ['Zürich', 'Remote / Hybrid']);
		assert.equal(positions[2].subcompany, 'Merantix Fund Management GmbH');
		assert.match(positions[0].descriptionHtml, /^<h3>Dein Impact zur Mission:<\/h3>/);
		assert.equal(positions[2].descriptionHtml, '', 'English-only posting, default feed');
		const english = personio.parseFeed(fixture('personio-feed-en.xml'));
		assert.match(english[0].descriptionHtml, /^<h3>What we do<\/h3>Physical commodity trading/);
		assert.match(english[0].descriptionHtml, /<h3>Your role<\/h3>/);
	});

	it('normalizes a position into an ingest posting', () => {
		const p = defaultFeed()[0];
		const job = personio.normalizePosition(p, { ...task, slug: 'voiio', company: 'voiio' });
		assert.equal(job.id, `personio_${p.id}`);
		assert.equal(job.url, `https://voiio.jobs.personio.de/job/${p.id}`);
		assert.equal(job.source_site, 'jobs.personio.de');
		assert.equal(job.company, 'voiio');
		assert.equal(job.location, 'Berlin');
		assert.equal(geoKeys(job.location), '|berlin-de|');
		assert.equal(job.workplace_type, 'unknown');
		assert.equal(job.job_type, 'full_time');
		assert.ok(job.description.startsWith('<h3>Dein Impact zur Mission:</h3>'));
	});

	it('reads remote offices as remote or hybrid', () => {
		const [, , mixed] = defaultFeed();
		assert.equal(personio.normalizePosition(mixed, task).workplace_type, 'hybrid');
		const allRemote = { ...mixed, offices: ['Remote'] };
		assert.equal(personio.normalizePosition(allRemote, task).workplace_type, 'remote');
	});

	it('fills text-less postings from the English feed, and drops "send us your CV" entries', async () => {
		const { http, calls } = fakeHttp((url) => ({
			body: fixture(url.endsWith('?language=en') ? 'personio-feed-en.xml' : 'personio-feed.xml'),
		}));
		const listings = await personio.list(task, { http });
		assert.deepEqual(
			calls.map((c) => c.url),
			['https://merantix.jobs.personio.de/xml', 'https://merantix.jobs.personio.de/xml?language=en']
		);
		assert.equal(listings.length, 3);
		assert.ok(listings.every((l) => !/Initiativbewerbung/.test(l.job.title)));
		assert.ok(
			listings.every((l) => l.job.description !== ''),
			'every posting has its text'
		);
		assert.ok(listings[1].job.description.startsWith('<h3>What we do</h3>'));
		assert.ok(
			listings.every((l) => l.detailUrl === null),
			'descriptions are inline'
		);
	});

	it('reads the board once when every posting came with text', async () => {
		const xml = fixture('personio-feed-en.xml');
		const { http, calls } = fakeHttp(() => ({ body: xml }));
		assert.equal((await personio.list(task, { http })).length, 2);
		assert.equal(calls.length, 1);
	});

	it('refuses a body that is not a Personio feed (a board that moved answers HTML)', () => {
		assert.throws(() => personio.parseFeed('<!DOCTYPE html><html></html>'), SourceFetchError);
	});
});

describe('smartrecruiters (Posting API)', () => {
	const task = { source: 'smartrecruiters' as const, company: 'Vattenfall', country: 'de' };
	type Page = { content: smartrecruiters.SrPosting[] };

	it('pages the board, filtered by country when the task names one', () => {
		const u = new URL(smartrecruiters.listUrl(task, 100, { http: fetch }));
		assert.equal(u.pathname, '/v1/companies/Vattenfall/postings');
		assert.equal(u.searchParams.get('country'), 'de');
		assert.equal(u.searchParams.get('offset'), '100');
		const whole = new URL(smartrecruiters.listUrl({ ...task, country: null }, 0, { http: fetch }));
		assert.equal(whole.searchParams.has('country'), false);
	});

	it('normalizes recorded postings', () => {
		const [berlin, hamburg] = fixtureJson<Page>('smartrecruiters-postings.json').content.map((p) =>
			smartrecruiters.normalizePosting(p, task)
		);
		assert.equal(berlin.id, 'smartrecruiters_744000163988834');
		assert.equal(berlin.url, 'https://jobs.smartrecruiters.com/Vattenfall/744000163988834');
		assert.equal(berlin.company, 'Vattenfall');
		assert.equal(berlin.location, 'Berlin, BE, Germany');
		assert.equal(geoKeys(berlin.location), '|berlin-de|');
		assert.equal(berlin.workplace_type, 'onsite');
		assert.equal(berlin.job_type, 'full_time');
		assert.equal(berlin.department, 'Customers & Solutions');
		assert.equal(hamburg.workplace_type, 'hybrid');
	});

	it('closes the empty region slot in a location', () => {
		assert.equal(
			smartrecruiters.locationText({ city: 'Berlin', fullLocation: 'Berlin, , Germany' }),
			'Berlin, Germany'
		);
	});

	it('builds the description from the job ad sections, in page order', () => {
		const job = smartrecruiters.normalizePosting(
			fixtureJson<Page>('smartrecruiters-postings.json').content[0],
			task
		);
		const detail = fixtureJson<smartrecruiters.SrDetail>('smartrecruiters-posting.json');
		const full = smartrecruiters.withDetail(job, detail);
		const order = ['Unternehmensbeschreibung', 'Stellenbeschreibung', 'Qualifikationen'].map((t) =>
			full.description.indexOf(`<h3>${t}</h3>`)
		);
		assert.ok(order.every((i) => i >= 0));
		assert.deepEqual(
			[...order].sort((a, b) => a - b),
			order
		);
		assert.equal(full.application_url, detail.applyUrl);
		assert.equal(full.url, job.url, 'the url stays the one the listing was keyed by');
	});
});

describe('pooled', () => {
	it('keeps order, bounds concurrency, and turns a rejection into its error', async () => {
		let inFlight = 0;
		let peak = 0;
		const out = await pooled([1, 2, 3, 4, 5, 6], 2, async (n) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			if (n === 4) throw new Error('four');
			return n * 10;
		});
		assert.equal(peak, 2);
		assert.deepEqual(out.slice(0, 3), [10, 20, 30]);
		assert.ok(out[3] instanceof Error);
		assert.deepEqual(out.slice(4), [50, 60]);
	});
});
