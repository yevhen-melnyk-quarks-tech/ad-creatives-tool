import type { Character, Frame, Scene } from "./types";
import { SEEDANCE_PROMPT_LIMIT } from "../models/replicate";

// Every CRITICAL block below is a fix for a defect that actually shipped during the
// POC, not speculative prompt padding. The comment on each says which one.

const STYLIZATION_BLOCK =
  "STYLIZATION — CRITICAL: strongly stylized animated characters, NOT realistic humans. Clearly exaggerated animated proportions — noticeably oversized heads, very large glossy expressive eyes with big irises and soft catchlights, simplified rounded noses, smooth clean matte skin with no pores and no fine wrinkles, soft simplified shading, appealing caricatured silhouettes, exaggerated readable facial expressions. NOT photorealistic, NOT live action, NOT hyperrealistic skin, no skin texture, no pores, no realistic human anatomy, no photographic rendering.";

// Real Carhartt, Ford and Apple marks appeared on jackets, car grilles and laptops.
const NO_BRANDS_BLOCK =
  "NO REAL BRANDS — CRITICAL: no real-world brand logos, badges, wordmarks or trademarks anywhere in any frame — not on clothing, jackets, vehicles, car grilles, phones, laptops, packaging, shop signage or products. Every car is a plain generic unbranded body shape with no badge and no recognisable manufacturer styling — not a recognisable real model of any make.";

// The first runs printed "(from <IMAGE 0>)" and "(as seen in <IMAGE5>)" into visible
// captions, and duplicated whole frames.
const CAPTION_HYGIENE_BLOCK =
  "CAPTION TEXT RULES — CRITICAL: caption text under each frame contains ONLY the caption wording given for that frame. Never mention the attached reference image, never write words like 'reference', 'IMAGE', 'as seen in', and never print any bracketed or angle-bracket tag. Do not restate character descriptions in the captions beyond the short name tag given. Every frame's caption is different from every other frame's caption.";

// A sheet drew a character holding a phone AND a second phone on the table; the video
// model escalated that into him pressing two phones to both ears for half the shot.
const PROP_HYGIENE_BLOCK =
  "PROP CONTINUITY — CRITICAL: each physical prop exists exactly once. If a character is holding a phone, there is no second phone anywhere else in that frame — not on a table, not in the other hand, not in the background. The same applies to every prop: one laptop, one bag, one cup, one set of keys. A character has exactly two hands and holds at most one of any given object. Never draw a spare, mirrored or duplicate copy of an object a character is already using.";

export function computeFrameTimings(scene: Scene) {
  const n = scene.frames.length;
  const step = scene.durationSeconds / n;
  return scene.frames.map((frame, i) => ({
    frame,
    start: Math.round(i * step),
    end: i === n - 1 ? scene.durationSeconds : Math.round((i + 1) * step),
  }));
}

function gridLayoutFor(frameCount: number): string {
  if (frameCount <= 4) return `${frameCount === 4 ? "2x2 grid" : "a single horizontal row"} layout`;
  if (frameCount === 5) return "a layout of 3 frames in the top row and 2 frames in the bottom row";
  if (frameCount === 6) return "a 3x2 grid layout";
  return `a layout of ${Math.ceil(frameCount / 3)} rows of up to 3 frames each`;
}

export function generateCharacterCardPrompt(characters: Character[]): string {
  const n = characters.length;
  const numberWord =
    ({ 1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six" } as Record<number, string>)[n] ?? String(n);

  return [
    "Pixar/Disney-style 3D animated character reference sheet, modern cinematic rendering, full-body wide shot.",
    "",
    `${numberWord} full-body characters standing side by side in a single horizontal row on a clean pure white seamless background, evenly spaced, all facing forward, neutral standing pose, arms relaxed at sides, soft even studio lighting, subtle contact shadow under each character's feet.`,
    "",
    "Stylized animated proportions — slightly oversized heads, large glossy expressive eyes with soft catchlights, gently simplified noses and mouths, smooth soft-shaded skin, warm appealing character design, readable silhouettes. NOT photorealistic, NOT live action, NOT real humans, no skin pores.",
    "",
    characters.map((c, i) => `CHARACTER ${i + 1} — ${c.name.toUpperCase()}: ${c.description}`).join("\n\n"),
    "",
    "Under each character place a clean centered black text label in simple capital letters:",
    characters.map((c, i) => `"CHARACTER ${i + 1} - ${c.name.toUpperCase()}"`).join("\n"),
    "",
    "Pure white seamless background. No props. No furniture. No extra characters. No borders, no panels, no grid lines, no frames.",
    "",
    "No text overlays other than the labels. No captions. No logos. No watermarks.",
  ].join("\n");
}

/**
 * Characters visible in a frame, detected from the action text.
 *
 * Naming characters alone let the model swap one for another in dialogue-heavy scenes,
 * since every face sits on the attached character card — so each frame's caption
 * restates who is in it. Exported so the QA critic audits against the exact same
 * expectation the prompt was built from; a second hand-maintained copy would drift.
 */
export function charactersInFrame(frame: Frame, sceneCharacters: Character[]): Character[] {
  // A per-frame list written by whoever authored the scene beats the guesswork below,
  // so it wins outright when present.
  if (frame.charactersPresent?.length) {
    const byName = new Map(sceneCharacters.map((c) => [c.name.toLowerCase(), c]));
    const listed = frame.charactersPresent
      .map((n) => byName.get(n.trim().toLowerCase()))
      .filter((c): c is Character => Boolean(c));
    if (listed.length) return orderBySubject(frame, listed, sceneCharacters);
  }

  const present = detectByName(`${frame.action} ${frame.dialogue?.character ?? ""}`, sceneCharacters);

  return orderBySubject(frame, present, sceneCharacters);
}

/**
 * Finds characters referenced anywhere in a piece of prose.
 *
 * The previous version required the character's FULL name to appear literally, and
 * prose never contains full names — a brief says "John's phone rings" and "the family
 * walks", not "John Carter walks". So detection returned nobody, the per-unit cast
 * collapsed to whoever happened to have a dialogue line, and the identity lock then
 * told the video model that the scene's protagonist did not exist. That is how a clip
 * ended up starring the boss instead of John.
 *
 * Matching is longest-name-first with the matched span masked out afterwards, which
 * is what keeps "John's Boss" from also counting as a hit for "John Carter" — a real
 * hazard whenever one character's name contains another's.
 */
export function detectByName(text: string, sceneCharacters: Character[]): Character[] {
  let haystack = ` ${text.toLowerCase()} `;
  const found: Character[] = [];

  const tryMatch = (needle: string): boolean => {
    const escaped = needle.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Allows a trailing possessive: "John's phone" is a reference to John. Word
    // boundaries on both sides so a short name cannot match inside a longer word.
    const re = new RegExp(`(?<![\\p{L}])${escaped}(?:'s|s')?(?![\\p{L}])`, "u");
    const m = re.exec(haystack);
    if (!m) return false;
    // Mask the span, so nothing else can claim the same words.
    haystack = haystack.slice(0, m.index) + " ".repeat(m[0].length) + haystack.slice(m.index + m[0].length);
    return true;
  };

  // Two passes, and the order is load-bearing. Every FULL name is matched first, so
  // "John's Boss" consumes that whole span before "John" is ever tried as a token —
  // otherwise the possessive allowance makes "John" match inside "John's Boss" and
  // both characters get reported for a scene containing only one of them.
  const byLength = [...sceneCharacters].sort((a, b) => b.name.length - a.name.length);
  for (const c of byLength) {
    if (tryMatch(c.name)) found.push(c);
  }
  // Token fallback: a first name, or a role word like "boss". Possessives are stripped
  // so "John's" and "John" are the same token.
  //
  // This deliberately errs towards matching too many rather than too few, and the
  // asymmetry is the reason. A character MISSED here is left out of the cast, and the
  // identity lock then states they do not appear while the action has them acting —
  // the contradiction that produced a clip starring the wrong man and a sheet of a
  // woman talking to nobody. A character matched in error only widens the cast, which
  // makes the lock permissive. Requiring tokens to be unique within the cast was tried
  // and rejected: with a "John's Boss" in the cast it made the bare name "John"
  // ambiguous, so "John waits" stopped identifying John Carter — a regression in
  // exactly the direction that does damage.
  const bare = (t: string) => t.replace(/['’]s$|s['’]$/i, "").toLowerCase();

  for (const c of byLength) {
    if (found.some((f) => f.id === c.id)) continue;
    const tokens = c.name
      .split(/\s+/)
      .map(bare)
      .filter((t) => t.length > 2)
      .sort((a, b) => b.length - a.length);
    if (tokens.some(tryMatch)) found.push(c);
  }

  // Back to the scene's own ordering; the sort above was only for match precedence.
  return sceneCharacters.filter((c) => found.some((f) => f.id === c.id));
}

/**
 * Whether the character speaking this line is actually in shot.
 *
 * A speaker heard down a phone, over a radio, or in voice-over is NOT the frame's
 * subject — the person listening is. Treating the speaker as the subject regardless is
 * what put a boss in a dominant foreground close-up while the man receiving his call
 * stood small in the background.
 *
 * Decided from `charactersPresent`, which is authored data about who is visible, rather
 * than by looking for words like "phone" in the prose. When that list is absent (a
 * hand-pasted scenario) the answer is unknowable, so the speaker is assumed visible —
 * the previous behaviour, and the safe default for an ordinary face-to-face scene.
 */
export function speakerIsVisible(frame: Frame): boolean {
  if (!frame.dialogue) return false;
  if (!frame.charactersPresent?.length) return true;
  const speaker = frame.dialogue.character.trim().toLowerCase();
  return frame.charactersPresent.some((n) => n.trim().toLowerCase() === speaker);
}

/** Puts the frame's subject first, so the model reads the right identity before the rest. */
function orderBySubject(frame: Frame, present: Character[], sceneCharacters: Character[]): Character[] {
  const subjectName = (
    // A shot type that names someone ("Close-up on John") is the clearest signal.
    sceneCharacters.find((c) => frame.shotType.toLowerCase().includes(c.name.toLowerCase())) ??
    // Otherwise the speaker, but only when they are actually in shot.
    (speakerIsVisible(frame)
      ? sceneCharacters.find((c) => c.name.toLowerCase() === (frame.dialogue?.character ?? "").toLowerCase())
      : undefined)
  )?.name;

  return subjectName
    ? [...present].sort((a, b) => (a.name === subjectName ? -1 : b.name === subjectName ? 1 : 0))
    : present;
}

function frameCaptionLine(
  timing: { frame: Frame; start: number; end: number },
  sceneId: string,
  frameIndex: number,
  sceneCharacters: Character[]
): string {
  const { frame, start, end } = timing;
  // Compact tag, not the full description. Injecting the full ~65-word description per
  // frame fixed identity but overloaded caption rendering — the model started garbling
  // the text and duplicating frames. Full descriptions live in the identity-lock block
  // instead, where they are instruction text rather than text to be drawn.
  const remoteVoice = Boolean(frame.dialogue) && !speakerIsVisible(frame);

  // Only characters actually in shot get their appearance injected here. Naming a
  // remote speaker's face and clothing in a frame's caption invites the image model to
  // draw them, which is how a telephone voice ended up standing on the pavement.
  const visible = charactersInFrame(frame, sceneCharacters).filter(
    (c) => !remoteVoice || c.name.toLowerCase() !== frame.dialogue!.character.toLowerCase()
  );
  const identities = visible
    .map((c) => `${c.name.toUpperCase()} (${c.tag || c.description.split(",").slice(0, 3).join(",")})`)
    .join(", ");

  // Dialogue lines already carry terminal punctuation — appending one produced ".." and "?.".
  const dialoguePart = frame.dialogue
    ? remoteVoice
      ? `DIALOGUE — ${frame.dialogue.character} (voice only, heard through the phone, NOT visible in this frame): ${frame.dialogue.line}`
      : `DIALOGUE — ${frame.dialogue.character}: ${frame.dialogue.line}`
    : `NO DIALOGUE.${frame.noDialogueSound ? ` Sound: ${frame.noDialogueSound}` : ""}`;

  return (
    `FRAME ${frameIndex + 1} — Caption below: "${start}–${end} sec | SCENE ${sceneId} — FRAME ${frameIndex + 1} — ${frame.label} | ` +
    `${frame.shotType}. ${identities ? identities + " " : ""}${frame.action} | ${dialoguePart}"`
  );
}

/**
 * Group references the prose uses instead of naming people.
 *
 * These cannot be mapped to specific characters — "the kids" means Mia and Liam here
 * and someone else in the next brief — so when one appears, asserting who is ABSENT
 * becomes unsafe. Scene 4-1 said "the family exits, the kids run ahead" with a cast of
 * two, so the lock forbade the very children the action describes.
 */
const GROUP_REFERENCE =
  /\b(the |his |her |their |our )?(family|kids|children|parents|everyone|everybody|the others|group)\b/i;

export const hasGroupReference = (scene: Scene): boolean =>
  scene.frames.some((f) => GROUP_REFERENCE.test(f.action));

function identityLockBlock(scene: Scene, allCharacters: Character[]): string | null {
  const present = scene.charactersInScene;
  if (!present.length) return null;
  const absent = allCharacters.filter((c) => !present.some((p) => p.id === c.id));

  return (
    `CHARACTER IDENTITY LOCK — CRITICAL: only ${present.map((c) => c.name).join(" and ")} appear in this scene. ` +
    present.map((c) => `${c.name} is the one described as: ${c.description}.`).join(" ") +
    // The negative clause is omitted when the action leans on a group noun: we cannot
    // tell who that group covers, and asserting the wrong absence is what produced a
    // sheet of a woman talking to nobody.
    (absent.length && !hasGroupReference(scene)
      ? ` ${absent.map((c) => c.name).join(", ")} do NOT appear in this scene at all — do not use their faces, hair, clothing or body types for anyone in any frame.`
      : "") +
    " Every frame must use the correct person for the character named in that frame's caption." +
    // Added after one sheet rendered the same character two different ways INSIDE
    // ONE SHEET — correct in frame 1, a different face/hair/skin in frame 4. The lock
    // above only prevented swapping one character for another; it never required a
    // single character to look the same from frame to frame.
    " SAME-SHEET CONSISTENCY — CRITICAL: each character must look absolutely identical in every frame of this sheet:" +
    " the same face shape, the same skin tone, the same hair style and hair length, the same beard, the same age." +
    " Do not restyle, re-age, re-tone or re-cast anyone between frames. If a character appears in three frames," +
    " all three must clearly be the same individual person."
  );
}

export function generateStoryboardPrompt(scene: Scene, allCharacters: Character[]): string {
  const timings = computeFrameTimings(scene);
  const layout = gridLayoutFor(scene.frames.length);

  const parts: string[] = [
    `A storyboard sheet showing exactly ${scene.frames.length} frames arranged in ${layout} on a white background. Exactly ${scene.frames.length} frames, no more and no fewer, each one distinct — do not repeat or duplicate any frame. Pixar/Disney-style 3D animated rendering, modern cinematic look.`,
    "",
    STYLIZATION_BLOCK,
    "",
    NO_BRANDS_BLOCK,
    "",
    PROP_HYGIENE_BLOCK,
    "",
    CAPTION_HYGIENE_BLOCK,
    "",
    "Each frame is 9:16 vertical ratio with a thin black border. Below each frame place clear black caption text on white.",
  ];

  const lock = identityLockBlock(scene, allCharacters);
  if (lock) parts.push("", lock);
  if (scene.screenLock) parts.push("", scene.screenLock);

  parts.push("", `Location for all frames — ${scene.location}. The location stays identical across every frame.`);
  if (scene.backgroundCustomers) parts.push("", scene.backgroundCustomers);

  parts.push("");
  timings.forEach((t, i) => parts.push(frameCaptionLine(t, scene.id, i, scene.charactersInScene), ""));

  parts.push(
    `Bold black title at the very top of the sheet: "STORYBOARD — SCENE ${scene.id}: ${scene.title} | Format: 9:16 vertical | Style: 3D animation | Duration: ${scene.durationSeconds} seconds | ${scene.frames.length} frames"`,
    "",
    `Clean ${layout}, thin black border lines around each frame, white background, black caption text clearly legible under every frame. No extra decoration.`
  );

  return parts.join("\n");
}

function buildSeedancePrompt(scene: Scene, allCharacters: Character[], useCompactTags: boolean): string {
  const absent = allCharacters.filter((c) => !scene.charactersInScene.some((p) => p.id === c.id));

  const parts: string[] = [
    `[Image1] is a character reference sheet — use it for every character's exact face, hair, build and clothing. [Image2] is the storyboard sheet for this scene — follow its ${scene.frames.length} frames in order, and match its style, characters and location exactly.`,
    "",
    `Pixar/Disney-style 3D animated scene, modern cinematic rendering, 9:16 vertical. ${scene.durationSeconds} seconds total, one continuous narrative sequence. Strongly stylized animated characters with oversized heads and large glossy eyes — NOT photorealistic, NOT real humans, no skin pores.`,
    "",
    `LOCATION LOCK — ${scene.location}. This location never changes.`,
    "",
  ];

  scene.charactersInScene.forEach((c) =>
    parts.push(`${c.name.toUpperCase()}: ${useCompactTags && c.tag ? c.tag : c.description}.`)
  );

  parts.push(
    "",
    (hasGroupReference(scene)
      ? `${scene.charactersInScene.map((c) => c.name).join(" and ")} appear in this scene. Where the action refers to a group such as "the family" or "the kids", render exactly the people that group implies and nobody else — do not invent additional adults.`
      : `Only ${scene.charactersInScene.map((c) => c.name).join(" and ")} appear — nobody else enters at any point.` +
        (absent.length
          ? ` ${absent.map((c) => c.name).join(", ")} do NOT appear; never use their faces, hair or clothing for anyone.`
          : "")),
    "",
    "No real brand logos, badges or wordmarks anywhere — all products and vehicles are generic and unbranded.",
    ""
  );

  scene.frames.forEach((frame, i) => {
    const dialoguePart = frame.dialogue
      ? speakerIsVisible(frame)
        ? ` ${frame.dialogue.character} says exactly, word for word: "${frame.dialogue.line}"`
        : // Heard, not performed on camera: the speaker must not be rendered in shot.
          ` ${frame.dialogue.character} is NOT visible in this shot — their voice is heard through the phone, saying exactly, word for word: "${frame.dialogue.line}". Show only the character listening; never place ${frame.dialogue.character} in the scene.`
      : " No dialogue.";
    parts.push(`SHOT ${i + 1} — ${frame.shotType}. ${frame.action}${dialoguePart}`, "");
  });

  parts.push("Only the lines above are spoken. No other words, no invented dialogue, no lines from any other scene.", "");

  if (scene.pacingOverride) parts.push(scene.pacingOverride, "");
  Object.entries(scene.voiceDirections ?? {}).forEach(([name, direction]) =>
    parts.push(`VOICE — ${name}: ${direction}`)
  );

  parts.push("", PROP_HYGIENE_BLOCK);
  parts.push("", "No background music. No subtitles. No captions. No text overlays. No watermarks.");

  return parts.join("\n");
}

/**
 * Full descriptions where they fit, compact tags where they don't — a three-character
 * scene overran the 4000-char limit by 307. Identity still comes from the attached
 * character card, so the shorter tag loses little.
 */
export function generateSeedanceVideoPrompt(scene: Scene, allCharacters: Character[]): string {
  const full = buildSeedancePrompt(scene, allCharacters, false);
  if (full.length <= SEEDANCE_PROMPT_LIMIT) return full;

  const compact = buildSeedancePrompt(scene, allCharacters, true);
  if (compact.length > SEEDANCE_PROMPT_LIMIT) {
    throw new Error(
      `Scene ${scene.id}: prompt is ${compact.length} chars even with compact tags — over the ${SEEDANCE_PROMPT_LIMIT} limit. Shorten the location or shot descriptions.`
    );
  }
  return compact;
}
