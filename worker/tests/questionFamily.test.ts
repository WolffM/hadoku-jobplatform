import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFollowUp, matchOption, questionFamily } from '../src/questionFamily.ts';

/**
 * Which questions are the same personal fact.
 *
 * Every question here is VERBATIM from a real application form the owner met
 * by 2026-10-01, and every expectation was reviewed by hand against the
 * classifier's output before being written down — tests generated from the
 * code's own output would only have enshrined its mistakes. One such mistake
 * was caught that way: the first employer rule put "Are you a current
 * government official…" in `current_employer`.
 *
 * The negative cases matter more than the positive ones. A question wrongly
 * left OUT of a family costs the owner one extra answer; one wrongly let IN
 * puts their answer to a different question on an application.
 */

const FAMILIES: [question: string, family: string][] = [
	// sponsorship — every phrasing, including two that never say "visa"
	['Will you now or in the future require visa sponsorship?', 'sponsorship'],
	[
		'Will you now or in the future require Samsara to commence (“sponsor”) an immigration case in order to employ you?',
		'sponsorship',
	],
	[
		'Will you now or in the future require immigration sponsorship to work for Instacart?',
		'sponsorship',
	],
	[
		'Will you now or in the future require our company to file a petition or application for a work visa?',
		'sponsorship',
	],
	[
		'Will you now or in the future require company sponsorship to retain or extend your work authorization?',
		'sponsorship',
	],
	// The text after "?" says "but is not limited to"; read whole, that is a negation.
	[
		'Do you currently require the company’s sponsorship or need the company’s assistance to obtain or maintain authorization to work legally in the United States? This includes, but is not limited to, H-1B visas (lottery and transfers), TN visas, E-3 visas, or other company-sponsored visas.',
		'sponsorship',
	],
	[
		'Do you need, or will you need in the future, any immigration-related support or sponsorship from the Company in order to begin or continue employment with the Company? This includes support (such as J-1, F-1 CPT letter or STEM OPT Training Plan).',
		'sponsorship',
	],

	// work authorization
	['Are you legally eligible to work in the United States?', 'work_authorization'],
	[
		'Are you currently legally authorized to work in the country in which this job is based (e.g. you are a citizen, you have a visa, etc.)?',
		'work_authorization',
	],
	['Do you have the right to work in the country you are applying to? *', 'work_authorization'],
	[
		'Are you currently authorized to work for Pinterest in the country in which you are applying for a position?',
		'work_authorization',
	],
	[
		'Are you legally authorised to work full-time in the country where this job is based?*',
		'work_authorization',
	],

	// demographics
	['What is your race and/or ethnicity? Please check all that apply.', 'race_ethnicity'],
	['Race/Ethnicity (Select all that apply)', 'race_ethnicity'],
	['How would you describe your racial/ethnic background? (mark all that apply)', 'race_ethnicity'],
	['Are you Hispanic/Latino?', 'hispanic_latino'],
	['Military Veteran Status', 'veteran'],
	['Are you a veteran or active member of the United States Armed Forces?', 'veteran'],
	['Disability Status', 'disability'],
	[
		'Do you have a disability or chronic condition (physical, visual, auditory, cognitive, mental, emotional, or other)?',
		'disability',
	],
	['Do you identify as a member of the LGBT2QIA+ community?', 'lgbtq'],

	// you
	['Most Recent Employer', 'current_employer'],
	['Current/Most Recent Company Name', 'current_employer'],
	['Current company (if applicable)', 'current_employer'],
	['Current/Most Recent Job Title', 'current_title'],
	['Which state or province do you currently live in?', 'state_of_residence'],
	['What U.S State do you currently reside in? *', 'state_of_residence'],
	['What is the zip code of your primary residence?', 'postal_code'],
	["What's your postal code? *", 'postal_code'],
	// The Quebec note follows the "?" and does not change what is asked.
	[
		'What is your current location? Please note we are unable to hire candidates based in Quebec at this time.',
		'current_city',
	],
	['Where are you currently located? (city, state)*', 'current_city'],
	['Location (City)*', 'current_city'],
	['Website(s)', 'website'],
	['Other Links', 'website'],
	['Do you have a GitHub URL?', 'github'],
	// Affirm's picker, Vanta's free text, Pinecone's label
	['Pronouns', 'pronouns'],
	['What are your pronouns? (Optional)', 'pronouns'],
	['Preferred Pronouns', 'pronouns'],

	// per-employer, grouped so the owner can untick the one they DID work at
	['How did you hear about this opportunity at Grafana?', 'how_heard'],
	['Before applying, how did you hear about Upstart?', 'how_heard'],
	['How did you learn about Aledade?', 'how_heard'],
	['Where have you learned about Samsara? Select all that apply.', 'how_heard'],
	['Have you previously worked at Samsara?', 'worked_here_before'],
	['Are you currently, or have you previously, worked for Instacart?', 'worked_here_before'],
	['Have you been employed by Upstart before?', 'worked_here_before'],
	['Are you a former CoreWeave employee?*', 'worked_here_before'],
];

for (const [question, family] of FAMILIES) {
	test(`${family}: ${question.slice(0, 70)}`, () => {
		assert.equal(questionFamily(question)?.id ?? null, family);
	});
}

/**
 * Questions that look like a family and must NOT join it. Each one would put
 * the owner's answer to a different question on a real application.
 */
const TRAPS: [question: string, why: string][] = [
	[
		'Are you legally entitled to work in Canada?',
		'another country: the US answer says nothing about Canada',
	],
	['Are you currently based in Ireland, or open to relocation to Ireland?*', 'another country'],
	[
		'Please indicate whether you are a “U.S. person”. U.S. person is defined as a (i) U.S. citizen or national',
		'export control, not work authorization',
	],
	[
		'Please list the state that you plan to be physically located in while employed with our company?',
		'the FUTURE, not where they live',
	],
	[
		'If you do require employee sponsorship or assistance for work authorization, please list the type of support needed.',
		'a follow-up to a different answer',
	],
	[
		"If you selected 'Other' for where you learned about Samsara, please share additional details.",
		'a follow-up',
	],
	[
		'Are you subject to an agreement with a former employer or other party (such as non-competition or non-solicitation)?',
		'a legal question that only mentions an employer',
	],
	[
		'Would you like to opt-in to receiving text messages for this role regarding the hiring process?',
		'unrelated',
	],
	[
		'Are you a current government official or were you a government official in the last five years (e.g. a company director)?',
		'the loose employer rule caught this',
	],
	[
		'Are you currently employed by an Aledade Partner Practice?',
		'a different fact from the current employer',
	],
	['Before applying, how familiar were you with Upstart?', 'familiarity, not how they heard'],
	['Agreement to Arbitrate', 'legal: every agreement is read on its own'],
	[
		'By clicking "Submit Application" I agree to the Aledade Applicant Privacy Policy & Terms of Service',
		'legal',
	],
	[
		'By checking this box, I consent to Pinterest collecting, storing, and processing my responses',
		'legal',
	],
	['Processing of Personal Data', 'legal'],
	[
		'At Samsara, we encourage employees to bring their whole selves to work (this includes applicants too!) Feel free to share your preferred name and pronouns (she/her, they/them, he/him, ze/zir etc.).',
		'asks for a name AND pronouns in one box',
	],
	['Gender', 'not grouped: "gender" and "gender identity" differ, and so do the owner\'s answers'],
	[
		'Are you able to work in the United States without sponsorship?',
		'negated: the right answer FLIPS',
	],
];

for (const [question, why] of TRAPS) {
	test(`stays alone (${why}): ${question.slice(0, 50)}`, () => {
		assert.equal(questionFamily(question), null);
	});
}

// matchOption: which option on THIS board says what the owner's answer says.

test('a contraction is the same option once normalised', () => {
	// Toast words it "don't"; the stored answer says "do not". This exact
	// mismatch blocked seven Toast applications on 2026-10-01.
	const toast = [
		'Yes, I have a disability (or previously had a disability)',
		"No, I don't have a disability",
		"I don't wish to answer",
	];
	assert.equal(
		matchOption('No, I do not have a disability', toast),
		"No, I don't have a disability"
	);
});

test("one pronoun answer lands in a board's longer wording", () => {
	// Vanta's free text took "He/Him"; Affirm's picker says "He/him/his".
	const affirm = [
		'He/him/his',
		'She/her/hers',
		'They/them/theirs',
		'My pronouns are not listed',
		'I prefer not to say',
		'I prefer to self describe',
	];
	assert.equal(matchOption('He/Him', affirm), 'He/him/his');
});

test('a plain yes/no picks the one option leading with that word', () => {
	assert.equal(matchOption('No', ['Yes', 'No', 'Decline to answer']), 'No');
	assert.equal(matchOption('yes', ['Yes, no restriction.', 'No']), 'Yes, no restriction.');
});

test('a yes/no with two options leading the same way is left to the owner', () => {
	assert.equal(matchOption('No', ['No, never', 'No, but I have applied before', 'Yes']), null);
});

test('an ambiguous containment is left to the owner, not guessed', () => {
	// Two LinkedIn options. Either could be right; neither is OUR call.
	assert.equal(
		matchOption('LinkedIn', ['LinkedIn (Datadog Page)', 'LinkedIn (Job Posting)', 'Indeed']),
		null
	);
});

test('a unique containment is taken', () => {
	assert.equal(matchOption('LinkedIn', ['LinkedIn', 'Indeed', 'Referral']), 'LinkedIn');
	assert.equal(matchOption('White', ['Asian', 'White', "I don't wish to answer"]), 'White');
});

test('Male never matches Female', () => {
	// The substring trap from the combobox bug, in a new place.
	assert.equal(matchOption('Male', ['Female', 'Non-binary']), null);
});

test('no options means the answer is taken as typed', () => {
	assert.equal(matchOption('Microsoft Corporation', []), 'Microsoft Corporation');
});

test('an empty answer suggests nothing', () => {
	assert.equal(matchOption('   ', ['Yes', 'No']), null);
});

test('every name of the United States lands in each of Chime’s menus', () => {
	const phone = ['United States +1', 'United Arab Emirates +971', 'United Kingdom +44'];
	const country = ['United States of America', 'United Arab Emirates', 'United Kingdom'];
	for (const answer of ['USA', 'U.S.A.', 'US', 'United States', 'America']) {
		assert.equal(matchOption(answer, phone), 'United States +1', answer);
		assert.equal(matchOption(answer, country), 'United States of America', answer);
	}
	assert.equal(
		matchOption('USA', ['United States', 'United States Minor Outlying Islands', 'Canada']),
		'United States'
	);
});

test('a follow-up is told apart from a question in its own right', () => {
	assert.equal(isFollowUp('If Yes, please share their name here'), true);
	assert.equal(isFollowUp("If you selected 'Other', please share additional details"), true);
	assert.equal(isFollowUp('Please describe your experience with Go'), false);
	assert.equal(isFollowUp('Do you have any relatives currently working for Airwallex?'), false);
});
