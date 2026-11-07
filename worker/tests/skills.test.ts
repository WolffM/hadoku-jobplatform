import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSkill, extractSkills } from '../src/skills.ts';

describe('extractSkills', () => {
	it('folds spellings onto one name and counts each once', () => {
		assert.deepEqual(extractSkills('Kubernetes (k8s) on AWS; Postgres and PostgreSQL'), [
			'postgresql',
			'aws',
			'kubernetes',
		]);
	});

	it('reads through HTML', () => {
		assert.deepEqual(extractSkills('<li>React</li><li>TypeScript&nbsp;</li>'), [
			'typescript',
			'react',
		]);
	});

	it('keeps c++, c#, .net and node.js apart from their prefixes', () => {
		assert.deepEqual(extractSkills('C++ and C# on .NET'), ['c++', 'c#', '.net']);
		assert.deepEqual(extractSkills('Node.js services'), ['node.js']);
		assert.deepEqual(extractSkills('a cluster node'), ['node.js'], 'a bare "node" is the alias');
	});

	it('takes a term ending a sentence, but not one inside a longer word', () => {
		assert.deepEqual(extractSkills('We write Rust.'), ['rust']);
		assert.deepEqual(extractSkills('trusted sparkling javanese'), []);
	});

	it('matches Go only where the context makes it the language', () => {
		assert.deepEqual(extractSkills("We go fast and you'll go far"), []);
		assert.deepEqual(extractSkills('Experience with Go'), ['go']);
		assert.deepEqual(extractSkills('Python, Go'), ['python', 'go']);
		assert.deepEqual(extractSkills('Golang microservices'), ['microservices', 'go']);
	});
});

describe('canonicalSkill', () => {
	it("maps a person's spelling onto the vocabulary", () => {
		assert.equal(canonicalSkill(' K8s '), 'kubernetes');
		assert.equal(canonicalSkill('Postgres'), 'postgresql');
		assert.equal(canonicalSkill('golang'), 'go');
		assert.equal(canonicalSkill('Elm'), 'elm', 'unknown terms pass through lower-cased');
	});
});
