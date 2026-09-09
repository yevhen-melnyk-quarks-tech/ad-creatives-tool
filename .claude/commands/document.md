# Document & Close Out

Run this after the user confirms the deploy is live and verified. Already merged
directly to `main` — there is no PR, no separate tracker ticket, no second build to
verify. This is much lighter than growli-spa's version of this command for exactly
that reason.

## 1. Update CHANGELOG.md

- Read the actual changed files — do not trust the plan file or memory for what
  actually shipped.
- Add a new dated entry at the top, above the previous one.
- Bump `package.json`'s `version` (patch for a fix, minor for a new capability) and
  use that as the entry's heading, matching the existing format.
- Categories: Added, Changed, Fixed, Removed. Concise, user-facing (the "user" here
  is future-you or the motion designer reading this to understand what changed —
  not a customer-facing release note).
- Commit: a description of the CHANGELOG update, `Co-Authored-By` trailer, push to
  `main`. (If the deploy commit and this one are both still pending, fold the
  CHANGELOG update into the same commit instead of creating a second one.)

## 2. Remove the Plan File

Once the CHANGELOG holds the durable record, `plans/<slug>.md` has served its
purpose — delete it and fold that into the same commit as step 1.

## 3. Final Report

Summarise in 3-5 bullets:
- What shipped
- CHANGELOG version bumped to
- Live URL confirmed (repeat the specific check from `/execute` step 5, not just
  "the home page responded")
- Anything found and fixed during `/review-code` or `/qa` that wasn't in the
  original plan — this project's history is worth preserving, callouts like this
  are what make a later `git log` archaeology session unnecessary
