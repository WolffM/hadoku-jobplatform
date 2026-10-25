# Response: the runner types Greenhouse's security code, and Samsara is sent

**To:** hadoku-jobplatform · **From:** hadoku-scraper · **Date:** 2026-10-24
**Answers:** hadoku-scraper `docs/handoff-greenhouse-security-code.md` (3d7c85a)

Built, deployed, and done by the handoff's own definition: the attended Samsara
send (`01252c11-d5bf-4b3f-bba7-f70554bfc506`, `greenhouse_8050373`) is
`submitted`, its confirmation page is in `after-code-1.png`, and
`reconcile-mail` matched Greenhouse's "Thank you for applying to Samsara" to it
(`confirmed_at` 2026-10-25T05:13:07Z, 28s after the code mail). The timer now
drains the other 20 approved Greenhouse rows under the caps.

It took three attempts. Two of them came from facts this repo had written down
from description, not data, so they are below.

---

## 1. What was built (hadoku-scraper 6a9623e, 1b61828, 9d2db23)

- `hadoku_scrape/apply/security_code.py` — a port of your `extractCode` and
  `mailMatch.ts` helpers, plus a read-only `MailFeed` client over the existing
  `scraper-service-key` grant. No new route, no new grant, nothing through
  jobplatform. A 403 is reported once and never retried.
- Only a mail received **after the submit click**, from `*.greenhouse-mail.io`,
  whose subject names this row's employer, and only the **newest** such mail.
  Polled every 10s for up to 180s.
- `GreenhouseFiller.answer_security_code` types the 8 boxes, reads them back,
  clicks **once**, and waits 20s for a confirmation or
  `#email-verification-error`. Missing, unreadable or refused code →
  `needs_manual`. Never a second submit.
- Caps in the runner: 3 sends per tick, 2 per employer per rolling 24h counted
  from `submitted` rows' `updated_at`. Held rows stay `approved`.
- Success evidence carries `security_code: true`. No code or mail body is
  logged or stored anywhere.
- Greenhouse `human_at_submit = False`; Ashby and Lever unchanged. The
  fingerprint check, approved-only rule and LinkedIn ban are untouched.

## 2. The code mail is HTML. Both parsers missed it — yours too

The feed delivers Greenhouse's application code mail as HTML, the code alone in
an `<h1>`. `extractCode` split the raw markup into lines and found nothing, so
the first attempt went to `needs_manual` (one submit, nothing typed) and your
Verification codes panel printed the raw HTML to the owner.

Fixed on both sides: hadoku-scraper 1b61828, and jobplatform 4582e40, which
turns the body into text lines before the line rules run and shows text, not
markup, when no code is found. The test fixtures on both sides are now the real
mail's structure; the old ones were plain text inferred from the description.

## 3. A status write drops the approval — so a retry needs the owner

`POST /applications/:id/status` nulls `approved_fingerprint` on every
transition except `submitted`. The failed first attempt therefore already
dropped Samsara's approval, and resetting the row to `approved` produced an
approved row with no fingerprint; the runner refused it before opening a page.

That is the correct behaviour and nothing was changed. The consequence worth
knowing: **every security-code failure costs a re-approval.** The retry path is
row → `filled` (with the approved fill's fingerprint and answers as evidence)
→ the owner clicks Approve → attended or timer send.

## 4. Samsara's confirmation wording was not recognised

Samsara confirms with "Thank you for submitting your application". The
runner's confirmation pattern knew "thank you for applying" only, so a send
that went through was reported "MAY OR MAY NOT have been sent" and set
`failed`; the row was corrected to `submitted` by hand once the mail feed and
the reconciler both confirmed it. Fixed in 9d2db23. A board confirming in other
words still lands as `failed`, never as `submitted` — `reconcile-mail` is the
cross-check for those.

Pinterest, on the first timer tick, confirmed with "Good news: your
application is in!" — the same miss, two more rows corrected by hand after the
page and the mail agreed, fixed in hadoku-scraper 3ea402f. Expect one more of
these per employer whose wording is new; each lands as `failed`, never as a
false `submitted`.

## 5. The first timer tick (2026-10-25 08:01–08:09 PDT)

The deploy waited for the scraper's 23:00–08:00 hold window, so the first
unattended tick ran at 08:01. Of the 20 remaining rows:

| Outcome                                      | Rows | Applications                                                |
| -------------------------------------------- | ---: | ----------------------------------------------------------- |
| Sent, code typed, confirmed                  |    3 | Toast `greenhouse_7587088`; Pinterest `8011573`, `8088867`  |
| Approved fill no longer matches (re-approve) |    6 | Toast ×3, Datadog ×2, Coinbase ×1                           |
| Required question with no answer             |    2 | Affirm ×2 (graduation year, race; Twitter/Portfolio on one) |
| Posting gone                                 |    2 | Toast `8046934`, Coinbase `8204215`                         |
| Held by the caps                             |    7 | 3/tick and Pinterest's 2/24h, as specified                  |

The caps held exactly. Every refusal stopped before a submit.

## 6. One thing asked of jobplatform: Pinterest's receipt subject

Pinterest mails a receipt the reconciler does not read. Measured subjects:

- `Your application for Sr. Staff Software Engineer, Pinterest Assistant at Pinterest`
- `Your application for Sr. Systems Engineer, Sales & Marketing at Pinterest`

Neither matches a confirmation rule or a `COMPANY_PATTERNS` entry in
`mailMatch.ts`, so both Pinterest sends read unconfirmed while Toast's "Thanks
for applying to Toast!" matched. Whether `Your application for <role> at
<Company>` is safe to treat as a confirmation — a rejection could plausibly
open the same way — is your call, and why it is asked rather than patched.

Otherwise nothing changes in jobplatform: `GET /verification-codes` still
refuses service identities and the Fill extension never types a code. The
runner's operator reports each day's sends and `needs_manual` rows to the
owner until the queue is drained.
