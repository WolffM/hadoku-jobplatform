# Mail request: a dedicated applications mailbox jobplatform can read

**To:** hadoku_site operator · **From:** hadoku-jobplatform · **Date:** 2026-09-19
**Nothing is merged for this yet** — unlike the Gemini request, this one is a
prerequisite rather than a switch to flip. No jobplatform code reads mail today,
and none should be written until the mailbox and its credential exist, because
the shape of the credential decides the shape of the reader.

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

A dedicated mailbox — **`applications@hadoku.me`** — with three properties:

| Property                                                                | Why it has to be this way                                                                                                                                             |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| It is the **applicant email** on future applications                    | Confirmations then arrive by CONSTRUCTION, not by filtering someone's personal inbox. No rules to maintain, no false matches.                                         |
| It **forwards everything** to the owner's real inbox                    | A recruiter replying to an application must never land somewhere only a robot reads. Forwarding is what makes the alias safe to adopt.                                |
| Its credential is **read-only**, vault-brokered, scoped to this mailbox | The reconciler needs to read confirmations. It has no reason to send, delete, or see anything else, and a read-only scope means a leaked key cannot act as the owner. |

**Read-only is load-bearing, not politeness.** The reconciler's whole job is to
be an independent check on the runner. A credential that could also send mail
would put the checker and the thing being checked inside the same blast radius.

### Credential shape

Either is workable; the operator's call:

- **IMAP** — username + app password, vault item `JOBPLATFORM_APPLICATIONS_MAIL`,
  declared in this repo's `.devvault.json` by name only. Simplest; works from
  the scraper without OAuth plumbing.
- **Google service account with domain-wide delegation** narrowed to that one
  mailbox, read-only scope. Better revocation story if hadoku.me is Workspace.

If IMAP, the mapping this repo would declare:

```json
"JOBPLATFORM_APPLICATIONS_MAIL_USER": "JOBPLATFORM_APPLICATIONS_MAIL_USER",
"JOBPLATFORM_APPLICATIONS_MAIL_PASS": "JOBPLATFORM_APPLICATIONS_MAIL_PASS"
```

Per the established flow: names are committed, values never are, and the grant
is operator-side. No `wrangler secret put`, no `.env`.

---

## 3. What jobplatform builds once it exists

1. **A reconciler** in hadoku-scraper that reads confirmations and matches them
   to queue rows on `(company, role, date window)`.
2. **Two new columns** on `applications`: `confirmed_at` and
   `confirmation_source`. A row claiming `submitted` with no confirmation after
   24h becomes visibly suspicious instead of quietly trusted.
3. **Mail-only applications get ingested as rows**, so a Pinecone-shaped
   application stops being invisible and the dashboard is one view of
   everything rather than one view of what the runner drove.

Direction matters: the inbox is the master list and the queue is reconciled
AGAINST it, never the reverse.

---

## 4. What this does NOT cover, and why it still needs doing

**Applications already sent go to the old address.** Pinecone's confirmation and
anything else historic landed in the owner's personal mail, and no alias created
today can retroactively receive them. Reconstructing the existing picture is a
ONE-OFF that needs the owner's main inbox — through the Gmail connector, or by
the owner forwarding what they find.

So this request fixes the pipeline going forward. It does not answer "what have
I already applied to?", and it should not be sold as if it does.

**Also worth deciding explicitly:** switching the applicant email changes what
employers see and reply to. That is the owner's call, not an implementation
detail, and it should be a deliberate yes rather than a side effect of wanting
better telemetry.
