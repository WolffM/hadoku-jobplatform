# hadoku Fill

A Chrome extension that fills Greenhouse, Ashby and Lever applications from your
hadoku job packet, so that **you** submit them from your own browser.

Why it exists: every board we apply through checks for a person at submit time.
Greenhouse holds the application until a code it emails is typed in, and Ashby
flags an automated browser as spam. The runner can prepare everything, but the
last step has to be yours. This extension takes care of the typing.

## What it does

On an application page it shows a small panel with **Fill**. Fill enters:

- your name, email, phone, LinkedIn/GitHub, location, education and work
  history (from your applicant profile on hadoku);
- the answers you **approved** for this application, and failing those, your
  saved answers, matched to this board's own wording;
- the tailored résumé made for this job.

It then lists anything it couldn't enter and anything still needed. It never
presses Submit and never types a verification code. On Greenhouse the panel
shows the emailed code once it arrives (it's also on the dashboard); you type
it in. When the board shows its confirmation, the panel marks the application
sent on hadoku. **Mark sent** does the same by hand.

## Send sessions

**Start sending** on the dashboard's Applications view works through every
ready application in one tab: approved ones first, then filled ones nobody
has reviewed yet (the session is that review). Each form fills itself as it
opens. You look it over, press Submit, and type the code if Greenhouse sends
one (the panel shows it). When the board confirms, the application is marked
sent and the next form opens. **Skip** moves on without sending. **Stop
session** ends it and leaves the current form filled.

## Install

```sh
pnpm build:extension        # writes extension/dist
```

Then in Chrome: `chrome://extensions` → turn on **Developer mode** → **Load
unpacked** → choose `extension/dist`. After pulling changes, rebuild and press
the extension's reload icon.

It uses your hadoku.me sign-in: stay signed in to hadoku.me in the same Chrome
profile.

## Test

```sh
pnpm test:extension         # builds, then fills a fixture form in Chromium
```
