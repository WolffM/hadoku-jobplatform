/**
 * Which technologies a posting asks for — the vocabulary behind GET /insights'
 * skill demand.
 *
 * Ported from JobPulse's matcher.py (2026-11-06), trimmed to the engineering
 * terms this corpus actually carries: its help-desk and IT-operations tail
 * ("ticketing", "windows 10") and its catch-alls ("api", "automation") named
 * something in nearly every posting and so ranked nothing. Each entry is one
 * canonical name with the spellings that mean it — JobPulse's SKILL_SYNONYMS,
 * folded in — so "k8s" and "Kubernetes" count once.
 *
 * Go is matched by context, never by the bare word: "go" is an English verb in
 * every other description. GO_RE is JobPulse's GOLANG_PATTERN.
 *
 * Scoring does not use this. stack_fit reads TITLE_TECH in scoring.ts, which is
 * a different question (what defines the role) from this one (what the
 * postings you are pursuing keep asking for).
 */

interface Skill {
	name: string;
	/** Lower-case spellings, matched as whole terms. Regex-escaped below. */
	aliases: string[];
}

const SKILLS: Skill[] = [
	// Languages
	{ name: 'python', aliases: ['python'] },
	{ name: 'javascript', aliases: ['javascript'] },
	{ name: 'typescript', aliases: ['typescript'] },
	{ name: 'java', aliases: ['java'] },
	{ name: 'kotlin', aliases: ['kotlin'] },
	{ name: 'c++', aliases: ['c++'] },
	{ name: 'c#', aliases: ['c#'] },
	{ name: 'rust', aliases: ['rust'] },
	{ name: 'ruby', aliases: ['ruby'] },
	{ name: 'php', aliases: ['php'] },
	{ name: 'swift', aliases: ['swift'] },
	{ name: 'scala', aliases: ['scala'] },
	{ name: 'sql', aliases: ['sql'] },
	{ name: 'bash', aliases: ['bash', 'shell scripting'] },
	// Frontend
	{ name: 'react', aliases: ['react', 'reactjs', 'react.js'] },
	{ name: 'vue', aliases: ['vue', 'vue.js', 'vuejs'] },
	{ name: 'angular', aliases: ['angular'] },
	{ name: 'svelte', aliases: ['svelte'] },
	{ name: 'next.js', aliases: ['next.js', 'nextjs'] },
	{ name: 'redux', aliases: ['redux'] },
	{ name: 'tailwind', aliases: ['tailwind', 'tailwindcss'] },
	{ name: 'graphql', aliases: ['graphql'] },
	// Backend
	{ name: 'node.js', aliases: ['node.js', 'nodejs', 'node'] },
	{ name: 'django', aliases: ['django'] },
	{ name: 'flask', aliases: ['flask'] },
	{ name: 'fastapi', aliases: ['fastapi'] },
	{ name: 'spring', aliases: ['spring', 'spring boot'] },
	{ name: 'rails', aliases: ['rails', 'ruby on rails'] },
	{ name: '.net', aliases: ['.net', 'asp.net'] },
	{ name: 'grpc', aliases: ['grpc'] },
	{ name: 'rest', aliases: ['rest', 'restful', 'rest api', 'rest apis'] },
	{ name: 'microservices', aliases: ['microservices', 'microservice'] },
	// Data stores
	{ name: 'postgresql', aliases: ['postgresql', 'postgres'] },
	{ name: 'mysql', aliases: ['mysql'] },
	{ name: 'mongodb', aliases: ['mongodb', 'mongo'] },
	{ name: 'redis', aliases: ['redis'] },
	{ name: 'elasticsearch', aliases: ['elasticsearch', 'opensearch'] },
	{ name: 'dynamodb', aliases: ['dynamodb'] },
	{ name: 'cassandra', aliases: ['cassandra'] },
	{ name: 'snowflake', aliases: ['snowflake'] },
	// Cloud and infrastructure
	{ name: 'aws', aliases: ['aws', 'amazon web services'] },
	{ name: 'gcp', aliases: ['gcp', 'google cloud'] },
	{ name: 'azure', aliases: ['azure'] },
	{ name: 'docker', aliases: ['docker'] },
	{ name: 'kubernetes', aliases: ['kubernetes', 'k8s'] },
	{ name: 'terraform', aliases: ['terraform'] },
	{ name: 'ansible', aliases: ['ansible'] },
	{ name: 'helm', aliases: ['helm'] },
	{ name: 'ci/cd', aliases: ['ci/cd', 'continuous integration'] },
	{ name: 'github actions', aliases: ['github actions'] },
	{ name: 'linux', aliases: ['linux'] },
	// Streaming and distributed systems
	{ name: 'kafka', aliases: ['kafka'] },
	{ name: 'rabbitmq', aliases: ['rabbitmq'] },
	{ name: 'spark', aliases: ['spark', 'pyspark'] },
	{ name: 'airflow', aliases: ['airflow'] },
	{ name: 'distributed systems', aliases: ['distributed systems'] },
	// ML and data
	{ name: 'machine learning', aliases: ['machine learning'] },
	{ name: 'deep learning', aliases: ['deep learning'] },
	{ name: 'llm', aliases: ['llm', 'llms', 'large language model', 'large language models'] },
	{ name: 'pytorch', aliases: ['pytorch'] },
	{ name: 'tensorflow', aliases: ['tensorflow'] },
	{ name: 'pandas', aliases: ['pandas'] },
	{ name: 'etl', aliases: ['etl'] },
	// Security and identity
	{ name: 'security', aliases: ['cybersecurity', 'information security', 'application security'] },
	{ name: 'oauth', aliases: ['oauth', 'oauth2', 'oidc', 'openid connect'] },
];

/** JobPulse's GOLANG_PATTERN: Go only where the context makes it the language. */
const GO_RE = new RegExp(
	[
		String.raw`\b(?:golang|go\s*lang(?:uage)?)\b`,
		String.raw`\bgo\s+(?:developer|engineer|dev|code|programming|backend)\b`,
		String.raw`\b(?:built|written|implemented|develop(?:ed)?|experience|coding|proficient|fluency|programming|looking for|seeking)\s+(?:in|with|for)?\s*go\b`,
		String.raw`(?:\bpython|\bjava|\bc\+\+|\brust|\bc#|\bkubernetes|\bdocker|\btypescript|\breact|\bkafka|\baws)[,\s/]+go\b`,
		String.raw`\bgo[,\s/]+(?:python|java|rust|c\+\+|c#|kubernetes|docker|typescript|react|kafka|aws)\b`,
	].join('|'),
	'i'
);

function escape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\/#]/g, '\\$&');
}

// Built once at load. A term is whole when the characters either side are not
// part of a word — and '+', '#' and '.' count as word characters here, so
// "c" never matches inside "c++" and "node" never matches inside "node.js"'s
// own alias list twice (it is the same skill either way).
const MATCHERS: [RegExp, string][] = SKILLS.map(({ name, aliases }) => [
	new RegExp(
		`(?:^|[^a-z0-9+#.])(?:${aliases.map(escape).join('|')})(?=$|[^a-z0-9+#]|\\.(?:[^a-z0-9]|$))`,
		'i'
	),
	name,
]);

/** Postings arrive as HTML (Greenhouse) or plain text; only the words matter. */
function plain(text: string): string {
	return text
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;|&#160;/gi, ' ')
		.replace(/&amp;/gi, '&');
}

/** The canonical skills a text names, each once, in vocabulary order. */
export function extractSkills(text: string): string[] {
	const t = plain(text);
	const found: string[] = [];
	for (const [re, name] of MATCHERS) if (re.test(t)) found.push(name);
	if (GO_RE.test(t)) found.push('go');
	return found;
}

/** Fold a person's own spelling ("K8s", "Postgres") onto the vocabulary's name. */
export function canonicalSkill(term: string): string {
	const t = term.trim().toLowerCase();
	if (t === 'go' || t === 'golang') return 'go';
	for (const { name, aliases } of SKILLS) if (aliases.includes(t)) return name;
	return t;
}

/**
 * A JSON list column (profiles.stack, profiles.keywords) as strings. Malformed
 * is empty, the default migration 0011 gives every profile.
 */
export function parseStringList(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const v: unknown = JSON.parse(raw);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
	} catch {
		// Not JSON: treated as no list, as above.
		return [];
	}
}
