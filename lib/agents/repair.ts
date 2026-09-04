import { generateStructured, TEXT_MODEL } from "../models/gemini";
import { projectCommittedUsd } from "../db";
import type { CriticReport, RepairPlan } from "./types";
import { blockingFindings } from "./types";

const REPAIR_SCHEMA = {
  type: "object",
  properties: {
    diagnosis: { type: "string" },
    promptAdditions: { type: "array", items: { type: "string" } },
    durableRule: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["diagnosis", "promptAdditions", "confidence"],
} as const;

/**
 * Turns a failed critic report into concrete prompt text.
 *
 * Deliberately additive: it appends constraints rather than rewriting the prompt, so a
 * repair can never quietly drop the scene's actual content. Every fix that worked by
 * hand in the POC had this shape — "never slicked back, never a pompadour" for a
 * drifting hairstyle, "one laptop, one bag, at most one of any object" for a
 * duplicated prop.
 */
export async function planRepair(opts: {
  stage: string;
  currentPrompt: string;
  report: CriticReport;
  onLog?: (m: string) => void;
}): Promise<RepairPlan> {
  // On a REVIEW the samples disagreed, so every finding was demoted to advisory and
  // there are no blocking ones left. Those advisories are exactly the
  // real-but-uncorroborated problems, so fall back to them rather than asking the
  // repair agent to fix an empty list.
  const blocking = blockingFindings(opts.report);
  const toFix = blocking.length ? blocking : opts.report.findings;

  const problems = toFix
    .map((f) => `- [${f.category}] ${f.subject ? `${f.subject}: ` : ""}${f.detail}`)
    .join("\n");

  const prompt = [
    `A generated ${opts.stage} failed automated quality review. Write the additional prompt constraints that would prevent these specific defects on a re-generation.`,
    "",
    "DEFECTS FOUND:",
    problems,
    "",
    "CURRENT PROMPT:",
    "---",
    opts.currentPrompt.slice(0, 6000),
    "---",
    "",
    "Rules for your response:",
    "- Return ADDITIONS only. Never rewrite or restate the existing prompt, and never alter the scene's story content, dialogue, shot list or character roster.",
    "- Each addition must be a directive sentence targeting one defect, phrased the way an image or video model follows best: concrete, visual, and negative where a specific wrong outcome must be excluded (e.g. 'hair worn very short and tight-cropped, never slicked back, never a pompadour').",
    "- Do not add stylistic flourish, mood, or camera language. Only constraints that close the defect.",
    "- If a defect looks like a one-off sampling artifact rather than something the prompt can control (a mangled hand, a momentary glitch), say so in the diagnosis, give no addition for it, and lower your confidence.",
    "- Set durableRule ONLY if this defect is likely to recur across other scenes and should become a permanent rule for every generation, not just this retry.",
  ].join("\n");

  return generateStructured<RepairPlan>({
    prompt,
    schema: REPAIR_SCHEMA as unknown as Record<string, unknown>,
    label: "repair",
    model: TEXT_MODEL,
    onLog: opts.onLog,
  });
}

export type RepairOutcome<T> = {
  result: T;
  attempts: number;
  finalReport: CriticReport;
  accepted: boolean;
  /** Additions applied across all attempts, for surfacing in the UI. */
  appliedAdditions: string[];
  stoppedBy?: "max-attempts" | "budget" | "no-progress";
};

/**
 * Generate → critique → repair → regenerate, bounded.
 *
 * `costPerAttemptUsd` and `budgetUsd` exist because the expensive failure mode is
 * re-rolling paid video. Cheap stages (storyboards, character cards) can iterate
 * freely; paid ones stop at the ceiling and hand back to a human with the report.
 */
export async function repairLoop<T>(opts: {
  stage: string;
  projectId: string;
  sceneId?: string;
  basePrompt: string;
  maxAttempts: number;
  costPerAttemptUsd?: number;
  budgetUsd?: number;
  /**
   * Attempt a repair when the verdict is REVIEW rather than stopping.
   * True for cheap image stages — a REVIEW there is worth one more free-ish roll.
   * False for paid video, where re-rolling on findings the samples disagreed about
   * means spending real money chasing noise.
   */
  repairOnReview?: boolean;
  /** Constraints carried in from a previous run, so a re-roll is not blind. */
  seedAdditions?: string[];
  /**
   * Text appended AFTER the repair additions — the operator's own correction.
   *
   * Order is the point. A human looking at the output outranks anything the repair
   * agent inferred, and a stale addition had been overriding a note that directly
   * contradicted it ("do not draw John ... even if mentioned in the frame
   * descriptions" beat an instruction to put John in both frames).
   */
  trailingInstruction?: string | null;
  generate: (prompt: string, attempt: number) => Promise<T>;
  critique: (result: T, prompt: string, attempt: number) => Promise<CriticReport>;
  onLog?: (m: string) => void;
}): Promise<RepairOutcome<T>> {
  const additions: string[] = [...(opts.seedAdditions ?? [])];
  const compose = () =>
    [opts.basePrompt, additions.length ? additions.join("\n") : null, opts.trailingInstruction]
      .filter(Boolean)
      .join("\n\n");
  let prompt = compose();
  if (additions.length) {
    opts.onLog?.(`  carrying ${additions.length} fix(es) forward from the previous run`);
  }
  let lastResult!: T;
  let lastReport!: CriticReport;
  let stoppedBy: RepairOutcome<T>["stoppedBy"];
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    if (opts.costPerAttemptUsd && opts.budgetUsd !== undefined) {
      // Committed, not just recorded: concurrent attempts must see each other's
      // in-flight cost or they all pass the check and overshoot together.
      const spent = projectCommittedUsd(opts.projectId);
      if (spent + opts.costPerAttemptUsd > opts.budgetUsd) {
        opts.onLog?.(
          `  budget guard: $${spent.toFixed(2)} spent, next attempt $${opts.costPerAttemptUsd.toFixed(2)} would exceed $${opts.budgetUsd.toFixed(2)} — stopping`
        );
        stoppedBy = "budget";
        break;
      }
    }

    attemptsMade = attempt;
    opts.onLog?.(`  ${opts.stage}${opts.sceneId ? ` ${opts.sceneId}` : ""}: attempt ${attempt}/${opts.maxAttempts}`);
    lastResult = await opts.generate(prompt, attempt);
    lastReport = await opts.critique(lastResult, prompt, attempt);

    if (lastReport.verdict === "PASS") {
      return { result: lastResult, attempts: attempt, finalReport: lastReport, accepted: true, appliedAdditions: additions };
    }

    // Nothing was assessed, so there is nothing to repair and retrying would just
    // hit the same filter.
    if (lastReport.verdict === "UNAVAILABLE") {
      opts.onLog?.(`  QA unavailable — ${lastReport.summary}`);
      break;
    }

    // REVIEW means the samples disagreed about whether this is a real defect.
    if (lastReport.verdict === "REVIEW" && !opts.repairOnReview) {
      opts.onLog?.(`  verdict REVIEW — not corroborated across samples, leaving for human review`);
      break;
    }
    if (lastReport.verdict === "REVIEW" && lastReport.findings.length === 0) {
      opts.onLog?.(`  verdict REVIEW with nothing specific to fix — leaving for human review`);
      break;
    }

    if (attempt === opts.maxAttempts) {
      stoppedBy = "max-attempts";
      break;
    }

    // A failing repair planner must not lose the artifact that was just generated.
    // It inherits the same content-filter exposure as the critic (its prompt quotes
    // the findings and the character descriptions), and an unhandled throw here
    // aborted the whole scene — and, in a bulk run, every scene after it.
    let plan: RepairPlan;
    try {
      plan = await planRepair({ stage: opts.stage, currentPrompt: prompt, report: lastReport, onLog: opts.onLog });
    } catch (err) {
      opts.onLog?.(`  could not plan a repair (${(err as Error).message}) — keeping this attempt for review`);
      stoppedBy = "no-progress";
      break;
    }
    opts.onLog?.(`  repair (${plan.confidence}): ${plan.diagnosis}`);

    const fresh = plan.promptAdditions.filter((a) => !additions.includes(a));
    if (fresh.length === 0) {
      // The repair agent has run out of new ideas; another identical retry is just
      // paying for the same dice roll.
      opts.onLog?.(`  repair produced no new constraints — stopping`);
      stoppedBy = "no-progress";
      break;
    }
    additions.push(...fresh);
    prompt = compose();
  }

  return {
    result: lastResult,
    attempts: attemptsMade,
    finalReport: lastReport,
    accepted: false,
    appliedAdditions: additions,
    stoppedBy,
  };
}
