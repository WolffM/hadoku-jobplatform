# Mail request: read-only access to application confirmations on hadoku.me

**To:** hadoku_site operator · **From:** hadoku-jobplatform · **Date:** 2026-09-19
**Nothing is merged for this yet** — this is a prerequisite rather than a switch
to flip. No jobplatform code reads mail today, and none should be written until
the mailbox and its credential exist, because the shape of the credential
decides the shape of the reader.

> **Revised 2026-09-19** after the operator corrected a wrong assumption in the
> first draft: `hadoku.me` mail is NOT Google-hosted, it is our own mail server.
> That removes the Google service-account option entirely, and — more usefully —
> means the EXISTING mail is reachable, so the backfill this document previously
> called impossible is now the main thing it asks for.

---

## 1. Why (one sentence a reviewer can check)

> Every record of whether an application was actually sent is produced by the
> component doing the sending, so the system cannot currently detect its own
> false negatives — and on 2026-09-19 it was caught reporting zero applications
> sent while the owner held a confirmation email for one it had never heard of.

The evidence, in order of how much it should worry a reviewer:

- **A confirmation arrived for an application with no row at all.** Pinecone,
  on Ashby. Every one of the 37 rows in `applications` is Greenhouse, across
  exactly four companies (coinbase, datadog, pinterest, toast). The queue is a
  record of what the RUNNER did, not of what the owner has applied to.
- **The queue can also hide rows it does have.** `GET /applications`
  (`worker/src/routes/jobs/applications.ts`) does
  `INNER JOIN jobs j ON j.id = a.job_id`, so an application whose job row was
  pruned from `jobs` silently vanishes from the list. No LIMIT, no default
  status filter — the join is the filter.
- **Success is matched by WORDING.** `is_submitted` (`apply/_answers.py`) is a
  regex over confirmation phrasing. A board that thanks an applicant in words
  the regex does not know is indistinguishable from a submit that never
  happened. That is not hypothetical: two Coinbase applications sat in `failed`
  under "the application MAY OR MAY NOT have been sent" on 2026-09-16.
- **The failure is silent in the dangerous direction.** A fill that enters
  nothing reports a blank field. A submit that half-worked reports ambiguity.
  Neither is as bad as an application the system does not know exists, because
  nothing surfaces it at all.

The ATS confirmation email is the only artefact in this pipeline not generated
by the code under test. That is precisely what makes it worth plumbing in.

---

## 2. What is being asked for

**A dedicated IMAP folder holding ATS mail, and a read-only credential scoped to
that folder alone.**

| Piece       | Detail                                                                         |
| ----------- | ------------------------------------------------------------------------------ |
| Folder      | `Applications` on `matthaeus@hadoku.me` (name is the operator's call)          |
| Filing      | A server-side rule (Sieve, or whatever the stack uses) copies ATS mail into it |
| Credential  | Read-only, IMAP over TLS, able to see **that folder and nothing else**         |
| Vault items | `JOBPLATFORM_MAIL_HOST`, `JOBPLATFORM_MAIL_USER`, `JOBPLATFORM_MAIL_PASS`      |

Declared in this repo's `.devvault.json` by name only. Per the established flow:
names are committed, values never are, and the grant is operator-side. No
`wrangler secret put`, no `.env`.

**Read-only is load-bearing, not politeness.** The reconciler's whole job is to
be an independent check on the runner. A credential that could also send, move,
or delete mail would put the checker and the thing being checked inside the same
blast radius — and a checker that can rewrite the evidence is not a checker.

**Folder-scoped rather than mailbox-scoped, for the same reason.** The reader
needs confirmations from employers. It has no business reading personal
correspondence, and a scope that excludes it by construction is worth more than
a promise that the code will not look.

### Why this shape rather than a new alias

The first draft asked for `applications@hadoku.me` as a new applicant address.
On reflection the folder is better on every axis that matters here:

|                                             | New alias       | Folder + rule **(asked for)**                |
| ------------------------------------------- | --------------- | -------------------------------------------- |
| Covers mail already received                | No              | **Yes** — re-run the rule over existing mail |
| Changes what employers see and reply to     | Yes             | **No**                                       |
| Catches a confirmation it was not expecting | By construction | Only if the rule matches                     |

The alias's one genuine advantage is that by-construction guarantee: mail lands
in the right place because of the address it was sent to, not because a pattern
matched. The folder rule is a heuristic and **will** miss unusual senders.

That is an acceptable trade because **a miss degrades to exactly today's
behaviour** — an unreconciled confirmation — rather than to something worse. And
the misses are observable: any confirmation the owner sees in their inbox that
never appeared in the dashboard is a rule that needs widening.

If misses become common in practice, the alias is still available as a later
hardening, and the two compose.

### Suggested starting rule

File on sender domain, which is what ATS confirmations have in common:

```
greenhouse.io · ashbyhq.com · lever.co · myworkday.com · smartrecruiters.com
icims.com · workable.com · jobvite.com · bamboohr.com
```

Sender domain rather than subject text on purpose: subjects are written by each
employer and vary wildly ("Thanks for applying", "We received your application",
Pinecone's "We're excited about your interest"), while the sending
infrastructure is the ATS's and is stable.

---

## 3. What jobplatform builds once it exists

1. **A reconciler** in hadoku-scraper that reads the folder and matches
   confirmations to queue rows on `(company, role, date window)`.
2. **Two new columns** on `applications`: `confirmed_at` and
   `confirmation_source`. A row claiming `submitted` with no confirmation after
   24h becomes visibly suspicious instead of quietly trusted.
3. **Mail-only applications get ingested as rows**, so a Pinecone-shaped
   application stops being invisible and the dashboard is one view of
   everything rather than one view of what the runner drove.

Direction matters: the inbox is the master list and the queue is reconciled
AGAINST it, never the reverse.

---

## 4. The backfill, which is now the most valuable part

Because the mail is on our own server, **every confirmation ever received is
still reachable.** Running the filing rule retroactively over existing mail
produces the true history of what has actually been applied to — which is a
question the system currently cannot answer at all, and answered wrongly on
2026-09-19.

Concretely, this is expected to surface:

- applications sent outside the runner entirely (Pinecone is one, there are
  likely more),
- any queue row whose recorded status the inbox contradicts,
- rejections and recruiter replies, which are a second signal the pipeline has
  never had.

**This is the reason to do the folder rather than the alias.** An alias would
have left the existing history unreachable and answered only for mail arriving
after the switch.

---

## 5. Open questions for the operator

1. **Which mail server / does it support Sieve?** The filing rule assumes
   server-side filtering. If the stack has none, the fallback is a credential
   scoped to the whole mailbox with the reader filtering client-side — which is
   a materially broader grant, and worth avoiding if there is any alternative.
2. **IMAP, or something better?** IMAP is assumed because it is universal, not
   because it was chosen. If the server speaks JMAP, that is preferable —
   cleaner incremental sync than tracking IMAP UIDs.
3. **Retention.** The reconciler needs sender, subject, date and body text. It
   does not need to keep the mail; matched confirmations can be reduced to a row
   and the message left where it is. Confirm that is the preferred handling
   rather than caching message bodies locally.
