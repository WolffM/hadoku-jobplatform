# Job Platform: features

What Job Platform does and how to use it. How it works inside is in
[contributing.md](contributing.md). "Friend" is a hadoku.me tier: an account
the owner has vouched for.

## The feed

**What it does.** The main screen: every posting the scraper has collected,
ranked against a profile. Score weighs how well the posting's title and
description match the profile's keywords, how close its seniority is to the
profile's, and whether its remote/hybrid/onsite status fits — no profile
selected scores nothing, it just lists.

**How to use it.** Pick a profile from the sidebar (or browse unscored).
Filter by minimum score, salary floor, distance from a place
(`near=`/`radius_miles=`, with an option to keep remote postings regardless
of distance), role track (IC vs. manager) and free-text search over title,
company and location. Hide postings you've already dismissed or queued for
the Fill extension. Sort by score, date or salary.

**What it does not do.** Salary is a filter and a sort, never part of the
score: most postings never list one, so scoring it would have scored noise as
signal. A posting naming no place the feed recognizes passes the `near=`
filter only as remote.

## Profiles

**What it does.** A profile is a saved description of a role: keywords,
seniority range, remote preference, and the companies you want scraped for
it. Keep several at once — one per kind of role you're considering.

**How to use it.** The sidebar lists your profiles; **New Profile** opens the
editor. Add a company to a profile by its name or its known board; the
scraper picks that company up on its next run (see
[contributing.md](contributing.md#architecture)). Deleting a profile does not
touch postings or triage state, only the profile itself.

**What it does not do.** A profile's companies are a _directive_, not a
filter: every job in the corpus is still ranked against the profile, not just
jobs from the companies it names. Adding a company gets it scraped; it does
not narrow the feed to only that company.

## Triage and the pipeline

**What it does.** Mark any posting **interested**, **dismissed** or **saved**
straight from its card. Moving it to **applied** opens it on a Kanban board
(To Apply → Applied → Interviewing → Offer → Rejected), with notes,
priority, a follow-up date and a timeline of what happened and when.

**How to use it.** Buttons on the job drawer set the state; a card on the
Pipeline tab can also be dragged between columns or changed from its own
select — both routes write the same state change, so the board is never a
second source of truth. Overdue follow-ups are flagged.

**What it does not do.** Tracking or logging an event on a posting with no
triage state yet is refused: track it starting from **interested**, not
cold. Clearing a posting's state deletes its timeline with it; a state
_change_ is permanent and cannot be deleted, only a person-written note can.

## Application packets

**What it does.** For one posting, generates a tailored résumé and cover
letter (built from a separate résumé service over a secured service call),
plus an optional intro email and screening answers. The job drawer's
**Generate packet** button produces copy-paste-ready markdown; **Mint a
link** turns it into a shareable URL.

**How to use it.** Open a posting, press **Generate packet**. Review the
résumé and cover letter inline; regenerate if the posting's description
changes meaningfully. Packets older than their posting's text are not
auto-refreshed.

**What it does not do.** Nothing is sent anywhere by this step — it only
produces text. Sending it is either the [Fill extension](#the-fill-extension)
or doing it by hand.

## The Fill extension

**What it does.** A Chrome extension, installed from a zip the dashboard
offers, that reads an approved application's packet and types your name,
contact details, work history, your approved answers and the tailored résumé
straight into the real Greenhouse, Ashby or Lever form. It never presses
Submit and never enters a verification code — both boards check for a human
at that exact step, so the last click is always yours.

**How to use it.** From the Applications view, install the extension once,
then open a queued application's **Fill** panel on the real board page. A
**Start sending** session walks every ready application in one sitting:
approved first, then unreviewed fills, one tab at a time; **Skip** moves on,
**Stop session** ends it with the current form left filled.

**What it does not do.** It cannot submit a form or solve a CAPTCHA.
LinkedIn is out of scope entirely — automating it risks the account being
flagged, a decision the team made deliberately and does not revisit per
posting.

## Insights

**What it does.** A summary of your own search: how many postings reached
each pipeline stage, response/interview/offer rates as a share of what you
applied to, your weekly pace over the last twelve weeks, the mix of
remote/hybrid/onsite you're applying to, and which skills show up most in
postings you're chasing versus your own saved skill list.

**How to use it.** Open the **Insights** tab. It reads only what you have
already triaged or logged; there is nothing to configure.

**What it does not do.** It does not predict anything or suggest what to
apply to next — it is a mirror of your own pipeline, not a recommender.

## Trivia

A profile named _Default_ is created automatically the first time anything
reads your profile list — even a one-off API probe — so that there is never
a scoring request with nothing to score against (`529af16`).
