import { generateStructured } from "../models/gemini";
import { db, uid } from "../db";
import type { CriticReport, Finding, Verdict } from "./types";

// Shared response shape for every vision critic. Findings carry their own `blocking`
// flag so each critic's prompt decides severity, while the runner stays generic.
export const CRITIC_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["PASS", "REVIEW", "FAIL"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          blocking: { type: "boolean" },
          category: { type: "string" },
          subject: { type: "string" },
          panels: { type: "array", items: { type: "integer" } },
          detail: { type: "string" },
        },
        required: ["blocking", "category", "detail"],
      },
    },
  },
  required: ["verdict", "summary", "findings"],
} as const;

type RawCritic = { verdict: Verdict; summary: string; findings: Finding[] };

/**
 * Runs one critic.
 *
 * `samples > 1` enables consensus. This exists because critic judgement is NOT
 * reproducible even at temperature 0: re-running the same audit over the same clips
 * flagged different borderline details each time (one pass called out bare feet,
 * the next called out hair volume on the same scene). Acting on a single sample means
 * re-rolling paid renders over coin flips, so a blocking verdict must repeat before
 * it counts. Defects that are actually there repeat reliably; noise does not.
 */
export async function runCritic(opts: {
  stage: string;
  projectId: string;
  sceneId?: string;
  attempt?: number;
  prompt: string;
  imagePaths: string[];
  samples?: number;
  onLog?: (m: string) => void;
}): Promise<CriticReport> {
  const samples = Math.max(1, opts.samples ?? 1);
  const results: RawCritic[] = [];
  let lastError: string | undefined;

  for (let i = 0; i < samples; i++) {
    try {
      results.push(
        await generateStructured<RawCritic>({
          prompt: opts.prompt,
          imagePaths: opts.imagePaths,
          schema: CRITIC_SCHEMA as unknown as Record<string, unknown>,
          label: `critic:${opts.stage}`,
          onLog: opts.onLog,
        })
      );
    } catch (err) {
      lastError = (err as Error).message;
      opts.onLog?.(`  critic sample ${i + 1} failed: ${lastError}`);
    }
  }

  if (results.length === 0) {
    // A safety block is not a quality verdict. It happens reliably when a scene's
    // cast includes a child: the character description plus a request to verify
    // appearance against the images trips a non-configurable content filter, which
    // relaxed safetySettings do not cover. Say so plainly instead of implying the
    // sheet was assessed.
    const blocked = /PROHIBITED_CONTENT|blocked/i.test(lastError ?? "");
    const report: CriticReport = {
      stage: opts.stage,
      sceneId: opts.sceneId,
      verdict: "UNAVAILABLE",
      summary: blocked
        ? "Automated QA could not run on this one — the vision model's safety filter refused to analyse it, which happens when a scene's cast includes a child. Review it yourself before approving."
        : `Automated QA could not run: ${lastError ?? "unknown error"}`,
      findings: [],
      error: lastError,
    };
    persist(opts.projectId, opts.attempt ?? 1, report);
    return report;
  }

  const report = reconcile(opts.stage, opts.sceneId, results);
  persist(opts.projectId, opts.attempt ?? 1, report);
  return report;
}

/**
 * Merges N samples. A blocking finding is kept as blocking only if it appears in more
 * than half the samples; one that appears once is downgraded to advisory rather than
 * discarded, so a real-but-marginal defect still reaches a human.
 */
function reconcile(stage: string, sceneId: string | undefined, results: RawCritic[]): CriticReport {
  if (results.length === 1) {
    const r = results[0];
    return {
      stage,
      sceneId,
      verdict: normalise(r),
      summary: r.summary,
      findings: r.findings ?? [],
    };
  }

  const majority = Math.floor(results.length / 2) + 1;
  const byKey = new Map<string, { finding: Finding; votes: number }>();

  for (const r of results) {
    // Count each distinct finding once per sample, so a sample that repeats itself
    // cannot manufacture a majority on its own.
    const seen = new Set<string>();
    for (const f of r.findings ?? []) {
      const key = `${f.category}|${(f.subject ?? "").toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = byKey.get(key);
      if (entry) entry.votes++;
      else byKey.set(key, { finding: { ...f }, votes: 1 });
    }
  }

  const findings: Finding[] = [];
  for (const { finding, votes } of byKey.values()) {
    const agreed = votes >= majority;
    findings.push({
      ...finding,
      blocking: finding.blocking && agreed,
      detail: agreed
        ? finding.detail
        : `${finding.detail} [seen in ${votes}/${results.length} passes — not corroborated, treat as advisory]`,
    });
  }

  const failVotes = results.filter((r) => normalise(r) === "FAIL").length;
  const hasBlocking = findings.some((f) => f.blocking);

  return {
    stage,
    sceneId,
    // Disagreement itself is signal: if some passes failed but no finding reached a
    // majority, that is exactly the "look at it yourself" case.
    verdict: hasBlocking ? "FAIL" : failVotes > 0 ? "REVIEW" : "PASS",
    summary: results[0].summary,
    findings,
    consensus: { samples: results.length, failVotes },
  };
}

// Trust the findings over the model's own verdict field: it sometimes returns PASS
// while listing a blocking finding, or FAIL on advisories alone.
const normalise = (r: RawCritic): Verdict =>
  (r.findings ?? []).some((f) => f.blocking) ? "FAIL" : r.verdict === "FAIL" ? "REVIEW" : r.verdict;

function persist(projectId: string, attempt: number, report: CriticReport) {
  db()
    .prepare(
      `INSERT INTO qa_runs (id, project_id, stage, scene_id, attempt, verdict, report_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      uid(),
      projectId,
      report.stage,
      report.sceneId ?? null,
      attempt,
      report.error ? "ERROR" : report.verdict,
      JSON.stringify(report)
    );
}
