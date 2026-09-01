import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyTier } from '../src/applyTier.ts';

describe('applyTier', () => {
	it('recognises the boards a proven adapter drives', () => {
		for (const url of [
			'https://jobs.ashbyhq.com/clera/8b2f8b13-58f2-408f-a440-28290ae4c637/application',
			'https://job-boards.greenhouse.io/coinbase/jobs/8154983',
			'https://boards.greenhouse.io/acme/jobs/12345',
			'https://jobs.lever.co/matchgroup/7fca4a70-174c-41a2-b44b-7ff1cb9422e7/apply',
		]) {
			assert.equal(applyTier(url, null), 'supported', url);
		}
	});

	it("sees the Greenhouse form under an employer's own careers page", () => {
		// The case that prompted this. The canonical board URL 302s TO here, so
		// there is no greenhouse.io page to fall back on — but the embed URL
		// still serves the real form and the adapter fills it.
		assert.equal(
			applyTier('https://www.coinbase.com/careers/positions/8154983?gh_jid=8154983', 'greenhouse'),
			'embedded'
		);
	});

	it('trusts gh_jid even when the ats column is empty', () => {
		// gh_jid is Greenhouse's own embed parameter; nothing else emits it.
		assert.equal(applyTier('https://careers.example.com/roles/42?gh_jid=42', null), 'embedded');
	});

	it('says no rather than shrugging at an ATS we cannot drive', () => {
		for (const url of [
			'https://acme.wd1.myworkdayjobs.com/careers/job/Engineer',
			'https://jobs.smartrecruiters.com/Acme/1234',
			'https://apply.workable.com/acme/j/ABC123/',
		]) {
			assert.equal(applyTier(url, null), 'unsupported', url);
		}
	});

	it('claims nothing about a page it does not recognise', () => {
		assert.equal(applyTier('https://example.com/careers/apply', null), 'unknown');
		assert.equal(applyTier(null, 'greenhouse'), 'unknown');
		assert.equal(applyTier('', null), 'unknown');
		assert.equal(applyTier('not a url', null), 'unknown');
	});

	it('does not mistake a lookalike hostname for a real board', () => {
		assert.equal(applyTier('https://jobs.lever.co.evil.test/acme/x/apply', null), 'unknown');
	});
});
