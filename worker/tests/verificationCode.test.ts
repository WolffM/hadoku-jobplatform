import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCode, mailText } from '../src/verificationCode.ts';

test('a code alone between asterisk rows (MyGreenhouse)', () => {
	const body =
		'Greenhouse\r\n\r\nHi,\r\n\r\nYour security code is:\r\n\r\n********\r\nz2iufgvn\r\n********\r\n\r\nEnter this code';
	assert.equal(extractCode(body), 'z2iufgvn');
});

test('a code after "code:" on the same line', () => {
	assert.equal(extractCode('Your security code: Ab3dE9xQ. It expires soon.'), 'Ab3dE9xQ');
});

test('a code alone on the line after the sentence that mentions it', () => {
	assert.equal(
		extractCode('Copy and paste this code into the security code field:\n\nAb3dE9xQ\n\nGreenhouse'),
		'Ab3dE9xQ'
	);
});

test('no code is invented from a signature or a plain word', () => {
	assert.equal(extractCode('Thanks for your interest.\n\nGreenhouse'), null);
	assert.equal(extractCode('Enter the code from your email.\n\nApplication'), null);
});

// The shape the mail feed delivered on 2026-10-24 (logo trimmed, code replaced).
const GREENHOUSE_HTML = `<!DOCTYPE html>
<html>
  <head>
    <link href="https://fonts.googleapis.com/css2?family=Nunito+Sans&display=swap" rel="stylesheet">
  </head>
  <body style="font-family:'Nunito Sans',Helvetica,Arial,sans-serif;font-size:14px;color:#15372C">
    <div id="main" style="background:#F9FAF9;">
      <img alt="Greenhouse Recruiting" style="padding:40px;" src="data:image/png;base64,iVBORw0KGgo">
      <div id="content" style="background:#fff;">
        <p>
          Copy and paste this code into the security code field on your application:
        </p>
        <h1>Ab3dE9xQ</h1>
        <p>
          After you enter the code, resubmit your application.
        </p>
      </div>
      <p>&copy; 2026 Greenhouse</p>
    </div>
  </body>
</html>
`;

test('the code alone in an <h1> of an HTML mail (Greenhouse application)', () => {
	assert.equal(extractCode(GREENHOUSE_HTML), 'Ab3dE9xQ');
});

test('an HTML mail without its code yields no code, and readable text', () => {
	const body = GREENHOUSE_HTML.replace('<h1>Ab3dE9xQ</h1>', '');
	assert.equal(extractCode(body), null);
	assert.ok(!mailText(body).includes('<'));
	assert.ok(mailText(body).includes('© 2026 Greenhouse'));
});
