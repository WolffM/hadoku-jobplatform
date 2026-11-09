# @wolffm/jobpulse

The JobPulse UI that hadoku.me mounts at `/jobpulse/`. Its source is
[jjk564/job-dashboard](https://github.com/jjk564/job-dashboard) (`frontend/`,
`npm run build:lib`); it talks to this repo's worker at `/jobplatform/api`.

This directory holds no code, only what publishes it:

- `source.json` names the exact commit. **Changing `ref` is the deploy and
  reverting it is the rollback.** Read the diff between the two commits first:
  the build runs that code.
- `publish.yml`'s `jobpulse-build` job checks that commit out on a GitHub-hosted
  runner with no secrets, installs with `npm ci --ignore-scripts`, and builds.
  The self-hosted `publish` job only packs the built files, so code from the
  other repo never runs where this repo's tokens live.
- The version is CI's (`next-version`), like every package here.
