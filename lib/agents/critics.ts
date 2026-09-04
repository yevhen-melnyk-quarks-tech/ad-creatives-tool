import { runCritic } from "./critic";
import { charactersInFrame } from "../pipeline/prompts";
import type { Character, Scene } from "../pipeline/types";
import type { CriticReport } from "./types";

// Shared severity contract. Kept in one place so every critic classifies the same way
// — the split between blocking and advisory is what stops the gate crying wolf.
const SEVERITY_RULES = [
  "Set blocking=true ONLY for: a character whose identity-defining attributes contradict the character card; the same character rendered as visibly different people across panels; a duplicated character within one panel; a duplicated prop a character is actively using (a phone in hand plus a phone on the table); a person who is not in the scene cast and is not scripted background; a blank or filler panel; a visible real-world brand logo; a severe spatial or anatomical hallucination.",
  "Set blocking=false for everything else, including: garbled or misspelled caption text drawn on the sheet, minor garment construction detail (a pocket, a seam, stitching, button count), lighting or colour-grade differences, and panel contents differing from any expected-character list.",
  "",
  "Identity-defining attributes, which must never drift: ethnicity and skin tone; hair style, length, texture, colour, hairline and VOLUME ON TOP; facial hair; apparent age; face shape and build; clearly different garments or colours. Hair is the attribute that drifts most often and most visibly — a character established with a tight crop reappearing with a raised, styled or swept-back top is a real failure even when everything else matches. Compare the silhouette of the head, not just the colour.",
  "",
  "Explicitly IGNORE as legitimate variation: facial expression, emotion, head angle, pose, gesture, camera distance, lens, framing, lighting, colour grade, background, and how much of the character is visible.",
].join("\n");

export async function critiqueCharacterCard(opts: {
  projectId: string;
  cardPath: string;
  characters: Character[];
  attempt?: number;
  onLog?: (m: string) => void;
}): Promise<CriticReport> {
  const prompt = [
    "You are auditing a generated CHARACTER REFERENCE SHEET for an animated ad. Everything downstream — every storyboard and every video clip — is generated from this sheet, so a defect here propagates to the whole production.",
    "",
    `The sheet must show exactly ${opts.characters.length} full-body characters in a single row on a pure white background, each with a black text label beneath them.`,
    "",
    "Required characters, in order:",
    ...opts.characters.map((c, i) => `  ${i + 1}. ${c.name} — ${c.description}`),
    "",
    "Check: is each character present, in the right order, matching their description on every identity-defining attribute, visually distinct from the others, and correctly labelled? Is the background pure white with no props or furniture?",
    "",
    "Set blocking=true for: a missing character, a character who contradicts their description, two characters who look like the same person, a wrong or missing label, extra people, or a non-white background. Set blocking=false for minor styling variance.",
    "",
    SEVERITY_RULES,
  ].join("\n");

  return runCritic({
    stage: "character_card",
    projectId: opts.projectId,
    attempt: opts.attempt,
    prompt,
    imagePaths: [opts.cardPath],
    onLog: opts.onLog,
  });
}

/**
 * Stage 1 gate: audits the storyboard sheet BEFORE any paid render.
 *
 * The critical check is cross-panel, not per-panel. The defect that shipped in the POC
 * was one sheet containing two different versions of the same character — correct in
 * panel 1, re-cast in panel 4 — which a per-panel "is the right character here?" audit
 * cannot see, and which the video model then followed faithfully.
 */
export async function critiqueStoryboard(opts: {
  projectId: string;
  cardPath: string;
  sheetPath: string;
  scene: Scene;
  attempt?: number;
  samples?: number;
  onLog?: (m: string) => void;
}): Promise<CriticReport> {
  const { scene } = opts;

  const expected = scene.frames.map((frame, i) => {
    const present = charactersInFrame(frame, scene.charactersInScene);
    return `  Panel ${i + 1} — ${frame.shotType}: expected ${present.length ? present.map((c) => c.name).join(", ") : "(none detected)"}`;
  });

  const prompt = [
    "You are auditing one storyboard sheet from an animated ad for CHARACTER IDENTITY ERRORS before it is sent to a paid video model.",
    "",
    "IMAGE 1 is the approved CHARACTER CARD — the single source of truth for how each character looks.",
    "IMAGE 2 is the STORYBOARD SHEET to audit. Read its panels in reading order (left to right, top to bottom) and number them from 1.",
    "",
    `Scene ${scene.id} — "${scene.title}". The cast of this scene is: ${scene.charactersInScene.map((c) => c.name).join(", ")}. Any of them may legitimately appear in any panel.`,
    "",
    "Best-effort expected panel contents, derived automatically by text-matching the action prose. It is INCOMPLETE: it routinely omits a character who is legitimately in frame as a two-shot, an over-the-shoulder foreground, or a background presence. Do NOT report a cast member as a problem merely for appearing in a panel they were not listed for, and do NOT report a listed character as missing unless the panel is incoherent without them.",
    ...expected,
    "",
    scene.backgroundCustomers
      ? `This scene has scripted background people, who are EXPECTED and must never be reported as intruders: ${scene.backgroundCustomers}`
      : "This scene has no scripted background people.",
    "",
    "Approved character descriptions:",
    ...scene.charactersInScene.map((c) => `  ${c.name}: ${c.description}`),
    "",
    "Report on two things:",
    "1. CARD FIDELITY — does each character on the sheet match the character card and the description above?",
    "2. CROSS-PANEL CONSISTENCY — for each character appearing in MORE THAN ONE panel, do all their appearances clearly depict the SAME INDIVIDUAL PERSON? This is the critical check. A sheet where a character is correct in one panel and re-cast, re-aged, re-toned or given different hair in another is a failure even if every panel looks well-drawn alone. Name the offending panel numbers.",
    "",
    SEVERITY_RULES,
    "",
    "Be strict on blocking findings: a false pass costs a paid video render.",
  ].join("\n");

  return runCritic({
    stage: "storyboard",
    projectId: opts.projectId,
    sceneId: scene.id,
    attempt: opts.attempt,
    prompt,
    imagePaths: [opts.cardPath, opts.sheetPath],
    samples: opts.samples,
    onLog: opts.onLog,
  });
}

/**
 * Stage 2 gate: audits the RENDERED clip via a contact sheet of sampled frames.
 *
 * Both stages are needed. The storyboard is not ground truth in either direction: one
 * sheet drifted a character's hair yet its clip came out clean, and nothing stops the
 * video model inventing drift a clean sheet never had.
 */
/**
 * Categories where a defect seen in a single frame is almost always a transient
 * render artifact rather than something a viewer perceives, so it must persist across
 * frames before it is allowed to block a paid clip.
 */
const TRANSIENT_CATEGORIES = /anatom|spatial|hallucinat|malform|extra (finger|limb|arm|leg)|digit/i;

const MIN_FRAMES_TO_BLOCK = 2;

/**
 * Whether an anatomy/spatial finding may ever block a paid clip.
 *
 * Default "never", which is a deliberate change from the original plan of "block if it
 * persists across frames". Evidence: after moving the critic to native resolution, one
 * clip was reported as "Sarah's crossed legs are anatomically mangled — her right leg
 * ends in a left foot" in 4 of 6 frames at HIGH confidence, and inspecting those frames
 * shows two ordinary crossed legs. Persistence and confidence therefore do not separate
 * a real defect from an over-read of stylised animation anatomy, so they cannot justify
 * spending money on a re-roll. Identity, wardrobe, duplication and brand-logo findings
 * are unaffected and still block — those have been reliable.
 *
 * Set VIDEO_ANATOMY_BLOCKS=persist to restore blocking when a defect persists.
 */
const ANATOMY_BLOCKS = process.env.VIDEO_ANATOMY_BLOCKS === "persist";

/**
 * Demotes findings that a still-frame audit cannot justify blocking a paid render on.
 *
 * Two rules, both from real false failures: an anatomy or spatial glitch visible in
 * only one sampled frame is a one-frame artifact (a clip reported as having "six
 * digits" and "legs fused into a malformed mass" was fine in motion), and a
 * low-confidence claim of the same kind is the model resolving genuine visual
 * ambiguity by asserting a defect. Persistent identity and wardrobe drift is
 * untouched — that is the thing this critic exists to catch.
 */
function demoteTransient(report: CriticReport): CriticReport {
  const findings = report.findings.map((f) => {
    if (!f.blocking || !TRANSIENT_CATEGORIES.test(`${f.category} ${f.detail}`)) return f;

    const frames = f.panels?.length ?? 0;
    const persists = frames >= MIN_FRAMES_TO_BLOCK && f.confidence !== "low";

    if (ANATOMY_BLOCKS && persists) return f;

    const why = !ANATOMY_BLOCKS
      ? "anatomy reads on stylised animation are unreliable, so this never blocks a paid render"
      : frames < MIN_FRAMES_TO_BLOCK
        ? `only visible in ${frames || "no"} sampled frame(s), so it reads as a momentary render artifact`
        : "reported with low confidence on an ambiguous detail";
    return {
      ...f,
      blocking: false,
      detail: `${f.detail} [seen in ${frames} of the sampled frames; not blocking — ${why}. Check it yourself if it matters.]`,
    };
  });

  return {
    ...report,
    findings,
    // Recompute: demoting every blocking finding turns a FAIL into a pass-with-notes.
    verdict: findings.some((f) => f.blocking)
      ? "FAIL"
      : report.verdict === "FAIL"
        ? "REVIEW"
        : report.verdict,
  };
}

export async function critiqueVideoScene(opts: {
  projectId: string;
  cardPath: string;
  framePaths: string[];
  scene: Scene;
  attempt?: number;
  samples?: number;
  onLog?: (m: string) => void;
}): Promise<CriticReport> {
  const { scene } = opts;
  const n = opts.framePaths.length;

  const prompt = [
    "You are auditing the RENDERED VIDEO of one scene from an animated ad before it ships. The clip is expensive to regenerate, so a false alarm has a real cost — be accurate rather than cautious.",
    "",
    "IMAGE 1 is the approved CHARACTER CARD — the single source of truth for how each character looks.",
    `IMAGES 2 to ${n + 1} are ${n} frames sampled evenly through the clip, at full resolution, in time order. Refer to them as frames 1 to ${n} (frame 1 is IMAGE 2). They are moments from one continuous shot, so a character must be the same individual in every frame they appear in.`,
    "",
    "For EVERY finding you must fill in `panels` with the frame numbers where you can actually see it, and `confidence`.",
    "",
    "This matters most for anatomy and spatial glitches. These clips are viewed in motion at 24fps: a malformed hand or limb visible in one frame is imperceptible and must NOT be treated as blocking, while the same defect present across several frames is real. So list every frame the defect appears in, and if you can only see it in one, say so rather than padding the list.",
    "",
    "Set confidence to `low` when the detail is genuinely ambiguous — curled fingers, a dark garment against shadow, crossed limbs in low contrast. Do not assert a defect to resolve an ambiguity; report it as low confidence instead.",
    "",
    `Scene ${scene.id} — "${scene.title}". Cast: ${scene.charactersInScene.map((c) => c.name).join(", ")}.`,
    "",
    scene.backgroundCustomers
      ? `Scripted background people, EXPECTED and never intruders: ${scene.backgroundCustomers}`
      : "This scene has no scripted background people.",
    "",
    "Approved character descriptions:",
    ...scene.charactersInScene.map((c) => `  ${c.name}: ${c.description}`),
    "",
    "Check card fidelity and cross-frame consistency, and watch for defects that only appear once the scene is rendered: duplicated props, a character interacting with two copies of the same object, a limb or hand belonging to the wrong person, or skin tone that does not match between a face and the hands attached to it.",
    "",
    SEVERITY_RULES,
  ].join("\n");

  return runCritic({
    stage: "video_scene",
    projectId: opts.projectId,
    sceneId: scene.id,
    attempt: opts.attempt,
    prompt,
    imagePaths: [opts.cardPath, ...opts.framePaths],
    samples: opts.samples,
    postProcess: demoteTransient,
    onLog: opts.onLog,
  });
}
