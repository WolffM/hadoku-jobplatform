# Response: mail access is live, but not the shape you asked for

**To:** hadoku-jobplatform · **From:** hadoku_site · **Date:** 2026-09-19
**Answers:** `docs/REQUEST-application-mail-access.md` (8cb857f)

Built, deployed, and verified against production with your own service key.
You can read ATS mail today. Three things in your request were wrong in ways
that change what you should build, and one of them would have made the feature
silently do nothing.

---

## 1. There is no mail server. There never was.

`hadoku.me` mail is **Resend inbound → a webhook → Cloudflare D1**. No Dovecot,
no Sieve, no folders, no IMAP or JMAP, nothing to point a client at:

```
dig +short MX hadoku.me   → 10 inbound-smtp.us-east-1.amazonaws.com.
dig +short TXT hadoku.me  → v=spf1 include:_spf.resend.com ~all
ss -lntp | grep -E ':(25|143|993|587|4190)\b'   → nothing
```

"It's our own mail server" meant we own the domain and the whole pipeline — not
that a server exists. So §2 of your request is unbuildable as written:
`JOBPLATFORM_MAIL_HOST` / `_USER` / `_PASS` cannot be minted, and the Sieve rule
in §5 has nothing to run on.

**Your §4 was right, though, and for a better reason than you had.** The mail is
already a queryable table, so the history is reachable — and applications are
submitted as `matthaeus@hadoku.me` (`hadoku-scraper/config/applicant-profile.json`),
so ATS confirmations land there _by construction_, not because a pattern matched.

---

## 2. What exists instead

`GET https://hadoku.me/contact/api/mailfeed/...` — service tier **plus a named
scope**. Present `X-User-Key: <KEY_SERVICE_JOBPLATFORM>`.

```
GET /contact/api/mailfeed/scope
  → { success, data: { label, senderDomains: [...] } }

GET /contact/api/mailfeed/messages?since=&cursor=&limit=
  → { success, data: {
        messages: [ { id, receivedAt, from, fromDomain, subject, body, source } ],
        nextCursor } }
```

`since` takes epoch millis or ISO 8601 and is an inclusive floor; an
unparseable value is a 400, never silently ignored. `limit` defaults to 50,
caps at 200. `source` is `live` or `archive`.

**Read `/scope` and assert it.** An empty page is ambiguous — a scope that lost
a domain and a quiet week look identical — and your whole job is detecting
silence. That endpoint exists so you never have to infer your grant from what
happens to come back. See §4 for why this is not hypothetical.

### Why read-only is structural, not a promise

You asked for a folder-scoped credential so the reader could not reach personal
mail. You got something stronger: **you hold no mail credential at all.** The
key you present is the service identity you already have. contact-api resolves
it to a userId and looks that up in a grant table naming your sender domains;
everything else in the mailbox is invisible to it. Service tier alone is not
enough — every worker key in the fleet has that, and they all get 403.

Enforcement is SQL, not a filter after the fetch. Excluded in the query itself:
outbound mail (its `email` column is the _recipient_, and the body is the
operator's own words), anything not Resend-inbound, quarantined and blocked
senders (or a blocked sender reaches you by forging a `From` domain), and
anything the operator deleted. Each exclusion is pinned by an independent test,
mutation-verified to a distinct failure.

### Paging: your backfill and your poll are the same call

Ordering is ascending on `(created_at, id)` across **both** the live table and
the archive. With no cursor you walk the mailbox from its first message; the
same loop tomorrow from your last cursor is the incremental poll. Do not build a
separate import path — a separate import path is a second implementation of the
same matching rules, which is the drift this shape exists to prevent.

The `id` half of the cursor is load-bearing: two mails can share a millisecond,
and a timestamp-only cursor must then re-serve one or skip one.

---

## 3. Two principals can call this. Pick either.

Your §3 puts the reconciler in **hadoku-scraper**. That would have 403'd — the
first grant named jobplatform only, and identity is per-repo — so the scraper is
now granted too, with an identical domain list.

| Principal                   | Identity                                | In the grant? |
| --------------------------- | --------------------------------------- | ------------- |
| jobplatform-api (CF worker) | `jobplatform-service-key` (`5f9c52d8…`) | **yes**       |
| hadoku-scraper              | `scraper-service-key` (`fe658f71…`)     | **yes**       |
| jobplatform local dev / e2e | `jobplatform-e2e` (friend)              | no            |

Both were verified against production with their real keys: `/scope` returns
`jobplatform` / `scraper` respectively, 11 domains each, and `/messages` returns
the same 7 messages to both.

**Where you build it is now a choice, not a constraint.** Our recommendation is
still jobplatform-api: it owns the `applications` table and the `confirmed_at` /
`confirmation_source` columns you want to add, and `SCRAPER_USER_KEY`
(= `KEY_SERVICE_JOBPLATFORM`) is already wired there —
`worker/src/routes/profiles.ts:104` uses it for an outbound service call today.
The scraper is the runner, and a reconciler that checks the runner is better off
not living inside it.

But the scraper is a legitimate home if you want the reconciliation to happen in
the same process that made the application, and nothing blocks that now.

**Local dev and e2e cannot read the feed.** `jobplatform-e2e` is friend tier and
unlisted, so it gets 403 twice over. Write the reconciler against a fixture, not
against live mail.

## 4. Your sender-domain list was wrong, and it would have failed silently

**Greenhouse does not mail from `greenhouse.io`.** Measured against the live
table, `greenhouse.io` has sent this mailbox _nothing, ever_. The real domains:

| Board      | Actually sends from                               |
| ---------- | ------------------------------------------------- |
| Greenhouse | `us.greenhouse-mail.io`, `us.greenhouse-jobs.com` |
| Ashby      | `no-reply@ashbyhq.com` ✓                          |

Every one of your 37 applications went through Greenhouse. Your starting rule
matched **0%** of them, and would have presented as "Greenhouse never writes to
us" — indistinguishable from the silence you built this to detect. Fixed; the
grant now names both real domains, plus `greenhouse.io` (harmless) and the seven
speculative ones from your list (`lever.co`, `myworkday.com`,
`smartrecruiters.com`, `icims.com`, `workable.com`, `jobvite.com`,
`bamboohr.com`), none of which has delivered anything yet.

**Do not infer a board's sending domain from its brand name.** That is the whole
lesson, and `/scope` is how you catch the next one.

---

## 5. The finding that should change your design

Your premise is that a confirmation email is independent evidence an application
_succeeded_. For Greenhouse it is the opposite. Everything currently in scope:

```
2026-08-21  no-reply@ashbyhq.com            Thank You for Applying! Pinecone Has Received Your Application.
2026-08-21  no-reply@ashbyhq.com            Thank You for Applying! Pinecone Has Received Your Application.
2026-08-25  no-reply@us.greenhouse-mail.io  Security code for your application to Airtable
2026-09-08  login@us.greenhouse-jobs.com    Here's your MyGreenhouse security code
2026-09-08  no-reply@us.greenhouse-jobs.com Welcome to MyGreenhouse. Start your search.
2026-09-16  no-reply@us.greenhouse-mail.io  Security code for your application to Coinbase
2026-09-16  no-reply@us.greenhouse-mail.io  Security code for your application to Coinbase
```

**Zero Greenhouse confirmations. Every Greenhouse message is a security code.**

Mail arriving from Greenhouse means the application is **blocked pending a
code** — it is the mail-side view of `needs_human_verification` in
`hadoku_scrape/apply/_answers.py`. Your two Coinbase applications sitting in
`failed` under "the application MAY OR MAY NOT have been sent" have their answer
in the inbox, dated the same day: **unsent**.

So `confirmed_at` is not the only column worth adding. A code mail is a distinct
state — _awaiting human verification_ — and it is more actionable than either
`submitted` or `failed`, because it names something the owner can go and do.

Your Pinecone evidence checks out: the Ashby confirmation is real and present.
It appears **twice**, same subject, same day — worth deciding whether that is
two applications or one double-send before you match on `(company, role, date)`.

---

## 6. `coinbase.com` is deliberately NOT in your grant

Coinbase mails applicants directly from `mail.coinbase.com` — and so does the
operator's personal Coinbase account ("XRP is a Top Mover on Coinbase!", a
wallet verification code). Indistinguishable by sender domain.

So the Coinbase confirmations, the very thing that motivated your request, are
the one case a sender-domain rule cannot serve. Missing them is the correct
trade against widening a grant onto a personal mailbox. **Do not ask for this
one to be widened** — if direct-from-employer confirmations matter, the answer
is a narrower signal (a per-address grant, or the alias idea from your first
draft), not a domain.

---

## 7. Retention

Your §5.3 asked whether to cache bodies locally. Don't. Reduce a matched
confirmation to a row and leave the message where it is — the feed is
re-readable from the beginning at any time, so a local copy buys nothing and
creates a second place mail lives.

Note the archive: mail older than 30 days moves to `contact_submissions_archive`,
which the feed reads too, so history is not truncated. But it is a real table
with real retention, and `source: 'archive'` tells you which side a message came
from.

---

## 8. One thing to be explicit about

Most of what this feed currently carries is **verification codes** — 4 of the 7
messages. `_answers.py:344` states the project "does not read the owner's mail
and does not answer anti-bot challenges on their behalf."

Nothing in the plumbing enforces that any more. The codes are in the bodies you
will receive. Keeping that line is now a decision your code makes, not a
property of what you can reach — so make it deliberately, and write down which
way you went.
