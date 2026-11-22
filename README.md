# hadoku-jobplatform

**Guide:** [overview](docs/guide/index.md) · [features](docs/guide/features.md) · [contributing](docs/guide/contributing.md) · [history](docs/guide/history.md) · [trivia](docs/guide/trivia.md)

An end-to-end job-search pipeline. It pulls postings off company ATS boards, scores
them against role profiles you define, lets you triage what survives, and assembles a
full application packet — tailored resume, cover letter, intro email, screening
answers — for the ones worth applying to.

Live at **[hadoku.me/jobplatform](https://hadoku.me/jobplatform)** (~7,600 postings in
the corpus as of August 2026). The job list is public; profiles, triage state, and
application packets need an account.

This is one app in the [hadoku.me](https://hadoku.me) ecosystem — a personal platform
where each app ships as an independently versioned npm package and gets mounted by a
parent site. Nothing here runs standalone; see
[The problem it solves](#the-problem-it-solves) below.

---

## The problem it solves

Job boards rank by recency and their own incentives. Searching them means re-reading
the same 200 postings weekly to find the four that changed. This inverts that: describe
the role you want _once_, as a profile, and every scrape run re-ranks the whole corpus
against it — filtering and ranking kept as separate questions, scored against signals
chosen because a listing rarely states seniority or salary in a structured way. The
scorer, role classifier and full data model are in
[contributing.md#architecture](docs/guide/contributing.md#architecture) and
[`ARCHITECTURE.md`](./ARCHITECTURE.md); what each screen does day to day is in
[features.md](docs/guide/features.md).

Two independently published packages live in this repo: `@wolffm/jobplatform` (the
React micro-frontend, `src/`) and `@wolffm/jobplatform-worker` (the Cloudflare Worker
API, `worker/`). The pipeline end to end, and how companies reach the feed as something
the scraper pulls rather than this app pushes, is in
[contributing.md#architecture](docs/guide/contributing.md#architecture).

Push to `main` publishes both packages to GitHub Packages and fires a
`packages_updated` dispatch that tells the parent site (hadoku_site) to pull the new
versions and redeploy — see [contributing.md#how-it-deploys](docs/guide/contributing.md#how-it-deploys).

---

## Getting access

A fresh clone installs, builds and passes every check with no credential and no
`.npmrc`: the `@wolffm/*` dev dependencies are npm aliases of their public npmjs copies
(`npm:@hadoku/<name>`). The dev server and the signed-in e2e suite talk to the real
hadoku.me API, so those need your own credential. Getting one is the same for every
hadoku repo, so the steps live on one page:
**[hadoku.me/docs/contributing/#jobplatform](https://hadoku.me/docs/contributing/#jobplatform)**.
The identity to ask for is `jobplatform-service-key`. Once you have it, `pnpm dev` and
`pnpm test:e2e` work as they are: they run through dev-vault (a dev dependency).

New to the project? [docs/ONBOARDING.md](docs/ONBOARDING.md) sets up all three
repos the pipeline spans, from GitHub access to a first passing test.

---

## Development

Requires Node 22+ and `pnpm`.

```bash
pnpm install
pnpm dev          # dev server on :5173, needs a credential — see Getting access above
```

The rest of the commands, the theming and logging conventions, and how a change
reaches production are in
[contributing.md](docs/guide/contributing.md).

---

## License

[MIT](./LICENSE).
