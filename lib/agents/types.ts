/**
 * UNAVAILABLE is distinct from REVIEW on purpose: it means no judgement was made at
 * all, not that the judgement was uncertain. Showing a failed critic as REVIEW made
 * it look like the sheet had been assessed and found borderline.
 */
export type Verdict = "PASS" | "REVIEW" | "FAIL" | "UNAVAILABLE";

/**
 * One thing a critic noticed.
 *
 * `blocking` is the whole design. The first version of this critic in the POC had no
 * such split and failed 10 of 15 storyboards — almost entirely on things that did not
 * matter (a scripted background cashier read as an intruder, a shirt pocket that does
 * not exist on the character card, panel contents differing from an expected-character
 * list that was itself derived by text-matching prose). A gate that cries wolf gets
 * switched off, so anything short of a real defect is recorded but never blocks.
 */
export type Finding = {
  blocking: boolean;
  category: string;
  subject?: string;   // character name, prop, panel — whatever the finding is about
  /**
   * Which panels/frames the defect is visible in. Load-bearing for video: a defect in
   * one sampled frame is usually an artifact nobody perceives in motion, while one
   * that persists across frames is real. Used to decide whether it blocks.
   */
  panels?: number[];
  confidence?: "high" | "medium" | "low";
  detail: string;
};

export type CriticReport = {
  stage: string;
  sceneId?: string;
  verdict: Verdict;
  summary: string;
  findings: Finding[];
  /** Populated when consensus ran: how many of N samples judged this a FAIL. */
  consensus?: { samples: number; failVotes: number };
  error?: string;
};

export const blockingFindings = (r: CriticReport) => r.findings.filter((f) => f.blocking);

export const verdictFromFindings = (findings: Finding[], uncertain = false): Verdict =>
  findings.some((f) => f.blocking) ? "FAIL" : uncertain ? "REVIEW" : "PASS";

/**
 * A repair proposal. Critics say what is wrong; the repair agent says what text to
 * change. Keeping them separate matters because the fix for a recurring defect belongs
 * in the *generator's* prompt, not in a one-off retry.
 */
export type RepairPlan = {
  diagnosis: string;
  promptAdditions: string[];
  /** Guidance the repair agent believes should become permanent, not per-attempt. */
  durableRule?: string;
  confidence: "high" | "medium" | "low";
};
