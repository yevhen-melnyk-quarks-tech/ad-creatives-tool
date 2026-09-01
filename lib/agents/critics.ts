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
export async function critiqueVideoScene(opts: {
  projectId: string;
  cardPath: string;
  contactSheetPath: string;
  scene: Scene;
  attempt?: number;
  samples?: number;
  onLog?: (m: string) => void;
}): Promise<CriticReport> {
  const { scene } = opts;

  const prompt = [
    "You are auditing the RENDERED VIDEO of one scene from an animated ad for CHARACTER IDENTITY ERRORS before it ships.",
    "",
    "IMAGE 1 is the approved CHARACTER CARD — the single source of truth for how each character looks.",
    "IMAGE 2 is a 4-up contact sheet of frames sampled evenly through the rendered clip, in time order (top-left, top-right, bottom-left, bottom-right). Treat each tile as a panel numbered 1-4. These are moments from one continuous shot, so a character must be the same individual in every tile they appear in.",
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
    "Check card fidelity and cross-tile consistency, and watch particularly for hallucinations that only appear in motion: duplicated props, extra limbs, malformed hands, a character interacting with two copies of the same object.",
    "",
    SEVERITY_RULES,
  ].join("\n");

  return runCritic({
    stage: "video_scene",
    projectId: opts.projectId,
    sceneId: scene.id,
    attempt: opts.attempt,
    prompt,
    imagePaths: [opts.cardPath, opts.contactSheetPath],
    samples: opts.samples,
    onLog: opts.onLog,
  });
}
