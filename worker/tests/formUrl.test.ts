import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formUrl } from '../src/formUrl.ts';

test('each board links to the form the Fill extension runs on', () => {
	assert.equal(
		formUrl({
			id: 'greenhouse_8053797',
			ats: 'greenhouse',
			slug: 'instacart',
			url: 'https://instacart.careers/x',
		}),
		'https://job-boards.greenhouse.io/embed/job_app?for=instacart&token=8053797'
	);
	assert.equal(
		formUrl({
			id: 'ashby_021cca9c-f937-4d97-8be7-bc83af8307be',
			ats: 'ashby',
			slug: 'vanta',
			url: '',
		}),
		'https://jobs.ashbyhq.com/vanta/021cca9c-f937-4d97-8be7-bc83af8307be/application'
	);
	assert.equal(
		formUrl({
			id: 'lever_63db4a0e-53a1-4dcc-b846-55ec47bd38b4',
			ats: 'lever',
			slug: 'aledade',
			url: '',
		}),
		'https://jobs.lever.co/aledade/63db4a0e-53a1-4dcc-b846-55ec47bd38b4/apply'
	);
});

test('without a board slug, the posting itself', () => {
	assert.equal(
		formUrl({ id: 'greenhouse_1', ats: null, slug: null, url: 'https://example.com/jobs/1' }),
		'https://example.com/jobs/1'
	);
});
