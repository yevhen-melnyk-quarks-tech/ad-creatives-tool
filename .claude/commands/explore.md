# Initial Exploration Stage

Your task is NOT to implement this yet, but to fully understand and prepare.

## Default Mode: Propose, Don't Interrogate

Unless explicitly asked for a back-and-forth discovery session, default to proposing
your best-judgment recommendation rather than asking open questions. For each
decision point, state your recommended answer in 1-2 sentences with brief reasoning,
then move on. Only ask a real question when the ambiguity would materially change
scope, cost, or is otherwise high-risk to guess wrong on. End with a single
consolidated confirm. Do not ask more than 2-3 questions total per session in this
mode.

## Responsibilities

- Read the actual current code before proposing anything — this codebase has a
  documented history of the plausible-sounding cause being wrong (see `PROJECT.md`
  "Operating principle"). `git log` on the files you're about to touch is often
  faster than guessing at intent from the code alone — several real fixes here only
  made sense once the commit history explained *why* something was written the way
  it was.
- Work out exactly how the change integrates: which pipeline stage(s) it touches
  (`lib/pipeline/`, `lib/models/`, `lib/media/`, `lib/jobs/worker.ts`), what it costs
  per attempt if it touches Gemini or Replicate, and whether it interacts with the
  job queue's concurrency model (see `PROJECT.md` — this has bitten the project
  twice already).
- Identify anything unclear or ambiguous. In propose mode, state your recommended
  interpretation directly rather than listing it as an open question — flag it only
  if it's high-risk to guess wrong on.
- Do NOT assume requirements or scope beyond what was explicitly described.

## No Issue Tracker

This repo has no JIRA/GitHub-issue equivalent — skip straight to `/create-plan`
once exploration is settled. The plan file *is* the record.

---

Confirm you understand, then describe the problem or feature in detail.
