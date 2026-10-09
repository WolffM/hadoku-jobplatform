import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { TextDecoder } from 'node:util';
import { zip } from '../../src/fillExtension/zip.ts';

/**
 * The dashboard's zip writer is what puts the Fill extension on a machine, so
 * a wrong offset or CRC means Chrome is handed a folder it cannot load. Read
 * the archive back the way an unzipper does — from the end record, through the
 * central directory, to each local header — and check every file survives.
 */
test('zip: an unzipper reads back every file intact', () => {
	const files = [
		{ name: 'manifest.json', text: '{"manifest_version":3}' },
		{ name: 'content.js', text: 'console.log("héllo — ✓")\n'.repeat(50) },
		{ name: 'empty.js', text: '' },
	];
	const bytes = zip(files);
	const view = new DataView(bytes.buffer);
	const decoder = new TextDecoder();

	const end = bytes.length - 22;
	assert.equal(view.getUint32(end, true), 0x06054b50);
	assert.equal(view.getUint16(end + 10, true), files.length);
	let at = view.getUint32(end + 16, true);
	assert.equal(at + view.getUint32(end + 12, true), end);

	for (const file of files) {
		assert.equal(view.getUint32(at, true), 0x02014b50);
		const size = view.getUint32(at + 24, true);
		const nameLen = view.getUint16(at + 28, true);
		const local = view.getUint32(at + 42, true);
		assert.equal(decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen)), file.name);

		assert.equal(view.getUint32(local, true), 0x04034b50);
		assert.equal(view.getUint16(local + 8, true), 0, 'stored, not compressed');
		const start = local + 30 + view.getUint16(local + 26, true);
		const data = bytes.subarray(start, start + size);
		assert.equal(decoder.decode(data), file.text);
		assert.equal(view.getUint32(local + 14, true), crc32(data));
		assert.equal(view.getUint32(at + 16, true), crc32(data));
		at += 46 + nameLen;
	}
});
