# PLAN — Application Kit ("blast applications out")

Status 2026-07-31. Goal: one button on a job → **everything needed to apply**,
in a single modal with copy buttons, and it **records** the application. Manual
apply only — you paste/upload/submit. Deliberately lean.

## The one requirement

A convenient tool to blast applications out. Click a posting → "Prepare
application" → copy each piece into the company's form / email → "Mark applied"
(which records what was sent). That's it.

## v1 kit (all produced by the button)

Already built (reuse): **tailored résumé**, **cover letter**, **shareable packet
link** (`hadoku.me/resume?v=slug`).

New (one LLM call → a structured bundle):

- **Intro / outreach email** — short note to a recruiter or hiring manager
- **"Why this company/role" hook** — 2-3 sentences (reused in email + form fields)
- **Screening-question answers** — the standard set pre-drafted: why you / why us /
  a relevant project / strengths / sponsorship / availability / notice period
- **Salary line** — anchored to the comp floor, phrased for the "expected comp" field
- **LinkedIn connection note** — ≤300 chars
- **Talking points** — 3-5 bullets for the recruiter phone screen

Constant (fill once, not regenerated):

- **Standard-fields block** — name, email, phone, LinkedIn, GitHub, location,
  work authorization, relocation/remote stance — copy-paste for the boring form fields

On **Mark applied**: record `{job_id, variant_slug, applied_at}`.

## Explicitly OUT (do not build)

Browser automation / auto-submit / Easy Apply · per-application form-field
scraping (the "approve/auto" tiers) · multi-packet history per job · referral/
contact features. If it isn't copy-paste-to-apply, it's out of v1.

## Architecture (minimal — 1 endpoint + 1 route + 1 migration + UI)

Client-orchestrated, mirroring today's "Generate packet" (each generation call
already rides its own edge 120s carve-out, so no new edge work and no server-side
timeout risk).

1. **resume-bot — one new endpoint** `POST /resume/api/application-extras`
   (`worker/src/application-extras.ts`, wired in `index.ts`, gated
   `requireMinTier('friend')`). Input `{job_title, company, description,
resume_markdown}`. One LLM call → JSON `{intro_email, why_hook,
screening_answers:[{q,a}], salary_line, linkedin_note, talking_points:[]}`.
   Reads the contact profile (below) for salary/auth/location context. Cache 24h
   keyed by job (like tailored-resume/cover-letter).

2. **Contact profile** — `resume:profile:contact` in CONTENT_KV (namespace
   `963eeaa358d44c88a7e4047303e20997`), a JSON blob the owner fills once:
   `{name, email, phone, linkedin, github, location, work_auth, relocation,
salary_line}`. Seed via wrangler KV put (dev-vault token). The résumé header
   block already carries name/email/phone/linkedin; this adds the rest and powers
   the standard-fields block + salary/sponsorship answers.

3. **jobplatform — thin proxy route** `POST /jobs/:id/application-extras`
   (`worker/src/routes/jobs.ts`) that binds to resume-bot's endpoint (same
   `callResumeBinding` pattern as /resume, /cover-letter, /packet-link). Keeps the
   UI on `/jobplatform/api`.

4. **jobplatform — migration**: add `variant_slug TEXT` to `job_states`. Set it
   when marking applied on a job that has a minted packet. Date = `updated_at`,
   status = 'applied'. (No new table — minimal.)

5. **jobplatform — JobDrawer UI**: rename "Generate packet" → **"Prepare
   application"**; expand the packet section into the full kit — each piece
   (résumé/cover already there + email, why-hook, screening Qs, salary, LinkedIn
   note, talking points + standard-fields block + the shareable link) with a Copy
   button. "Mark applied" stores the variant slug.

## Build order

1. Collect owner inputs → seed `resume:profile:contact` (KV).
2. resume-bot: `application-extras.ts` + route + build/publish.
3. jobplatform: migration (`job_states.variant_slug`) + proxy route + build/publish.
4. jobplatform: JobDrawer kit modal + copy buttons + mark-applied records slug.
5. E2E in-browser: click a job → Prepare → copy each → Mark applied → confirm the
   record. (Auth: browser login with the service caller key from
   `hadoku-scrape/.devvault.local.json` — it rotates; re-read on "Invalid key".)

## Inputs still needed from the owner (blocks steps 1-2)

- **Work authorization** (US citizen / need sponsorship?)
- **Location + relocation stance** (remote pref already known)
- **Salary line** to state (e.g. "$350k+ total comp" or a band)
- Any other always-asked field to bake into the standard-fields block

## Pointers

- Existing packet flow: jobplatform `worker/src/routes/jobs.ts` (`/jobs/:id/resume`,
  `/cover-letter`, `/packet-link`, `callResumeBinding`) + `src/components/JobDrawer.tsx`
  (`handleGenerate`, `handleCreateLink`). resume-bot `worker/src/tailored-resume.ts`,
  `cover-letter.ts`, `variants.ts`, `index.ts`.
- Blocks/tailoring context: memory `resume-blocks-seed-pending` (51-block palette,
  the token-budget lesson), `job-search-project`, `job-preferences` ($350k floor).
