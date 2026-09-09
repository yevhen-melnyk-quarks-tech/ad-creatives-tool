Now implement precisely as planned, in full.

Implementation Requirements:

- Write elegant, minimal, modular code, matching the style already in the file
  (long explanatory comments on the *why*, not the *what* — see `PROJECT.md`).
- Adhere strictly to existing patterns (`lib/pipeline/`, `lib/media/`, `lib/models/`,
  `lib/jobs/worker.ts`) and the concurrency/disk-safety constraints in `PROJECT.md`.
- As you implement each step, update the plan file's emoji status and overall
  progress percentage.

---

## After Implementation: Local Build

Once all code steps are complete:

1. Start the dev server if it isn't already running (do not ask the user to run it).
2. **`npm run typecheck`** — must pass clean.
3. **`npm run build`** — must pass clean (catches anything typecheck alone misses).
4. **`/review-code`** — run on any change except pure refactors, renames, or
   comment-only edits. Apply every recommended fix directly — no confirmation gate.
5. **`/qa`** — empirical verification (see `/qa`'s own rules for what that means
   here — this is not a Playwright-spec project). Run again if `/review-code`
   changed anything.
6. **`/visual-review`** — run if any UI changed. Skip only for pipeline/server-only
   changes with no UI impact.
7. Report all results in a summary table.
8. **Ask the user:** "Local build looks good. Ready to deploy?"

Do not proceed to deploy without explicit user confirmation. If any page FAILED
visual review (3 iterations exhausted): show the screenshots inline and ask how to
proceed before asking about deploying.

---

## After User Confirms: Deploy

There is no staging environment — this is a single Railway service, and a push to
`main` plus a deploy *is* the release. Treat the confirmation above as the one gate
before something goes live.

1. Commit all changes: a long, explanatory message describing the actual root
   cause/motivation and key decisions, not just a summary of the diff — this
   project's `git log` is written to be read later without the conversation that
   produced it (see `PROJECT.md`). End with the `Co-Authored-By` trailer from the
   session's attribution instructions.
2. `git push origin main`
3. `railway up --detach --service ad-creatives-tool`
4. Poll `railway deployment list` (or the equivalent status check) every 15s until
   the new deployment shows `SUCCESS`. If it shows `FAILED`/`CRASHED`, pull the
   build logs, diagnose, and fix before reporting anything to the user.
5. Confirm the live URL actually responds: `curl` the home page, and specifically
   the endpoint/flow this change touched — a 200 on `/` does not prove a specific
   API route or job kind works, check the thing that actually changed.
6. **Ask the user:** "Deployed and verified live at
   `https://ad-creatives-tool-production.up.railway.app`. Ready to document and
   close out? (run `/document`)"

Do not skip step 5 — "the deploy succeeded" and "the feature works in production"
are different claims, and this project has shipped a clean build that then failed
on the live volume/job queue before (see `PROJECT.md`).
