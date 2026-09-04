import { generateStructured, TEXT_MODEL } from "../models/gemini";
import { estimateSceneDuration } from "../pipeline/timing";
import { normalizeScenario } from "../pipeline/normalize";
import { ScenarioSchema, type Scenario, type Character, type Frame } from "../pipeline/types";
import { estimateGeminiUsd, type Usage } from "../models/pricing";

/**
 * Turns a raw creative brief — pasted straight from a Notion task, in whatever
 * language and shape a motion designer wrote it in — into a full Scenario.
 *
 * This exists because requiring hand-written Scenario JSON is the wrong bar for the
 * person actually using this tool: the brief a designer works from looks like the
 * screenshot this was built against — a "ПЕРСОНАЖІ" section with loose age/wardrobe/
 * personality notes, then a "СЦЕНАРІЙ" section of scene headers, action paragraphs,
 * and "[Name] line" dialogue, mixing Ukrainian narration with English dialogue.
 * None of that is the shape the pipeline needs (per-frame shot types, a durationSeconds
 * per scene, a fully specified visual description per character), so an LLM does the
 * same transformation a human would do by hand — the same conversion this tool's
 * author did manually for every scenario before this existed.
 */

// The LLM's job is everything genuinely creative: inventing full visual identities
// from loose hints, splitting scenes into frames, choosing shots. It does NOT compute
// durationSeconds — that number needs to match the SOP's validated words/sec pacing
// exactly, which a code-side calculation does reliably and an LLM does not.
const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    characters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          tag: { type: "string" },
          description: { type: "string" },
        },
        required: ["name", "tag", "description"],
      },
    },
    scenes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          location: { type: "string" },
          // Empty string, not omitted, when there is none — Gemini's structured
          // output does not support a nullable keyword the way OpenAPI does, so an
          // empty-string sentinel is resolved back to null during hydration below.
          backgroundCustomers: { type: "string" },
          // Locks what a screen in shot may show. Empty string when the scene has no
          // phone/laptop/terminal visible.
          screenLock: { type: "string" },
          charactersInSceneNames: { type: "array", items: { type: "string" } },
          // Per-character voice performance direction. The video model uses these to
          // cast and perform the dialogue; the manual pipeline set them on 14 of 15
          // scenes and without them voices are arbitrary and drift between scenes.
          voiceDirections: {
            type: "array",
            items: {
              type: "object",
              properties: { characterName: { type: "string" }, direction: { type: "string" } },
              required: ["characterName", "direction"],
            },
          },
          frames: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                shotType: { type: "string" },
                action: { type: "string" },
                dialogueCharacterName: { type: "string" },
                dialogueLine: { type: "string" },
                noDialogueSound: { type: "string" },
                // Everyone visibly in this frame. Supplied rather than derived,
                // because deriving it from the prose is guesswork that once excluded
                // a scene's own protagonist.
                charactersPresent: { type: "array", items: { type: "string" } },
              },
              required: [
                "label", "shotType", "action", "dialogueCharacterName", "dialogueLine",
                "noDialogueSound", "charactersPresent",
              ],
            },
          },
        },
        required: [
          "title", "location", "backgroundCustomers", "screenLock",
          "charactersInSceneNames", "voiceDirections", "frames",
        ],
      },
    },
  },
  required: ["title", "characters", "scenes"],
} as const;

type RawCharacter = { name: string; tag: string; description: string };
type RawFrame = {
  label: string;
  shotType: string;
  action: string;
  dialogueCharacterName: string;
  dialogueLine: string;
  noDialogueSound: string;
  charactersPresent: string[];
};
type RawScene = {
  title: string;
  location: string;
  backgroundCustomers: string;
  screenLock: string;
  charactersInSceneNames: string[];
  voiceDirections: { characterName: string; direction: string }[];
  frames: RawFrame[];
};
type RawBrief = { title: string; characters: RawCharacter[]; scenes: RawScene[] };

// One real, validated character description, given to the model as a calibration
// example so its inventions land at the same level of visual specificity — vague
// output here ("a man in his 30s") is useless for character-identity lock later.
const CALIBRATION_EXAMPLE =
  'tag: "mid-30s Black man, dark brown skin, very short tight-cropped natural black hair (never slicked back), neat short beard, dark green overshirt over a white tee"\n' +
  'description: "adult Black man in his mid-thirties, dark brown skin, very short tight-cropped natural black hair worn close to the head — never slicked back, never a pompadour, no styled quiff — well-groomed short black beard, calm friendly dark brown eyes, easy reassuring smile, average solid build, upright relaxed posture. Wearing a fitted dark green casual overshirt over a plain white t-shirt, dark slim chinos, clean white leather sneakers, a simple silver watch"';

function buildPrompt(rawText: string): string {
  return [
    "Convert this creative brief for a Pixar/Disney-style animated ad into a structured shot-by-shot scenario. The brief was written by a motion designer for their own reference — it will not already be in the shape you need to output, so use judgement to fill every field.",
    "",
    "RAW BRIEF (verbatim, may mix languages — narration is often not English, dialogue often already is):",
    "---",
    rawText.slice(0, 20000),
    "---",
    "",
    "CHARACTERS:",
    "- Extract every named character, including ones mentioned only in dialogue tags or in passing.",
    "- Invent a COMPLETE Pixar-style visual description for each, in ENGLISH, from whatever hints the brief gives (age, rough wardrobe, role, personality). Where the brief specifies nothing about ethnicity, skin tone, hair, or build, invent something SPECIFIC and concrete — never vague, never generic, never identical between two characters. This text becomes a hard identity lock for image and video generation, so it must be visually unambiguous: adult age bracket, skin tone, hair style/length/colour, facial hair if any, build, and complete wardrobe down to shoes.",
    "- Calibration example of the specificity and format wanted:",
    CALIBRATION_EXAMPLE,
    "- `tag` is a compact ~15-word version of `description` for use in captions.",
    "- Treat every character with the same level of detail and dignity regardless of their role in the story — do not default a background or service character to a thinner description than a lead.",
    "",
    "SCENES:",
    "- Preserve every dialogue line VERBATIM in its original language and wording — never translate it, never invent a new line, never drop a line, never merge two lines into one.",
    "- Every OTHER field (title, location, action, label, noDialogueSound) must be written in English regardless of what language the brief's narration is in — these drive image and video generation prompts, which require English. Translate the brief's scene descriptions into English; do not translate the dialogue lines themselves.",
    "- `charactersPresent`: list EVERY character VISIBLE in that frame, using the exact names from the character list. Include a character who is on screen but silent. This list is used to lock identity, and a character left out of it is explicitly told not to appear — so omitting the person the shot is about produces a clip starring the wrong character.",
    "- Crucially, `charactersPresent` means VISIBLE, not merely audible. A character heard down a phone, over a radio, through a door or in voice-over is NOT visible and must NOT be listed, even though they have the dialogue line for that frame — the person listening is who the shot is on. Listing a telephone voice as present makes the image model draw them standing in the scene beside the person taking their call.",
    "- If a remote speaker should be seen, give them their own separate frame with their own location (for example the boss in his office on a video call) and list them as present only in that frame.",
    "- Write `action` so it names characters explicitly by name. Never rely on a group noun alone: write \"John, Sarah, Mia and Liam walk down the street\" rather than \"the family walks\". Never use a bare pronoun as the only reference to who is acting. Never offer the reader a choice of staging — \"split screen or focus on X\" is a note to a designer, not a shot; pick one and describe it.",
    "- One frame per dialogue line, in order. If a scene opens with descriptive action before any line is spoken, add ONE leading frame for it with no dialogue (dialogueCharacterName and dialogueLine both empty strings), label it something like 'establishing', and use a wide or medium shot.",
    "- `title` is a SHORT descriptive name for the scene — three or four words, no scene number and no 'Scene N:' prefix (the number is added separately, so including it reads as a duplicate).",
    "- `location` must be a full visual description of the setting, not a one-word label — invent plausible concrete detail (materials, colours, light) if the brief only names the place, since this drives a consistent background across every frame of the scene.",
    "- Vary `shotType` naturally across a scene rather than repeating one shot for every frame; use a suggested vocabulary of: Wide shot, Medium shot, Medium close-up, Close-up, Extreme close-up, Two-shot, Over-the-shoulder. Favour closer shots for emotionally intense lines.",
    "- `charactersInSceneNames` lists every character who speaks OR is clearly present in the scene's action text, using the exact name string from the `characters` list.",
    "- `backgroundCustomers`: only for scripted background people the scene explicitly calls for (e.g. a cashier, a crowd) — empty string if none, never invent one.",
    "- `noDialogueSound`: a short ambient sound description for a frame with no dialogue (e.g. 'quiet kitchen ambience'), empty string if not applicable.",
    "",
    "VOICE DIRECTIONS — one entry for every character who speaks in the scene. Describe the voice and the performance in a single phrase the way a casting note would: accent, register, age of voice, and the emotional delivery this particular scene needs. For example: 'neutral American accent, warm tired male delivery, gentle and quiet, a soft promise he is not sure he can keep' or 'neutral American accent, small bright curious child's voice, innocent and hopeful, slightly high and eager'. Keep a character's accent and vocal age identical in every scene so the same person is recognisable throughout the ad, and vary only the emotional delivery to match the moment.",
    "",
    "SCREEN LOCK — set this ONLY when a phone, laptop, tablet, card terminal or other screen is visible in the scene. Write a directive keeping its content non-legible, since generated screen text comes out garbled: e.g. 'SCREEN LOCK — CRITICAL: the phone display is never legible to the viewer. It is always angled away from camera. Never render any numbers, any interface text or any logo on the screen.' Empty string when no screen is in shot.",
  ].join("\n");
}

export type BriefParseResult = { scenario: Scenario; warnings: string[]; usd: number };

export async function parseBrief(rawText: string, onLog?: (m: string) => void): Promise<BriefParseResult> {
  if (!rawText.trim()) throw new Error("Brief text is empty");

  // Parsing runs in an API route rather than the worker, so it is outside the ambient
  // usage sink and reports its own cost back to the caller to record.
  let usage: Usage = { promptTokens: 0, outputTokens: 0, images: 0 };

  const raw = await generateStructured<RawBrief>({
    prompt: buildPrompt(rawText),
    schema: BRIEF_SCHEMA as unknown as Record<string, unknown>,
    label: "brief-parse",
    model: TEXT_MODEL,
    onLog,
    onUsage: (u) => { usage = u; },
  });

  return { ...hydrate(raw), usd: estimateGeminiUsd(usage) };
}

/** Turns the LLM's loosely-typed output into a Scenario that matches the pipeline's schema exactly. */
function hydrate(raw: RawBrief): Omit<BriefParseResult, "usd"> {
  const warnings: string[] = [];
  const orNull = (s: string) => (s.trim() ? s : null);

  if (!raw.characters?.length) throw new Error("Parser found no characters in the brief");
  if (!raw.scenes?.length) throw new Error("Parser found no scenes in the brief");

  // Dedupe by name, case/whitespace-insensitive — the same character can otherwise
  // get invented twice under slightly different casing from the same brief.
  const seen = new Map<string, RawCharacter>();
  for (const c of raw.characters) {
    const key = c.name.trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) warnings.push(`Character "${c.name}" appeared more than once — kept the first.`);
    else seen.set(key, c);
  }

  const characters: Character[] = [...seen.values()].map((c, i) => ({
    id: i + 1,
    name: c.name.trim(),
    tag: c.tag.trim(),
    description: c.description.trim(),
  }));

  const byName = new Map(characters.map((c) => [c.name.toLowerCase(), c]));
  // Falls back to a first-name match: a brief's dialogue tags are often just "[Mia]"
  // even when the character list carries "Mia Carter", and the model does not always
  // normalise that gap on its own.
  const byFirstName = new Map(characters.map((c) => [c.name.split(/\s+/)[0].toLowerCase(), c]));
  const resolveName = (name: string): Character | null => {
    const key = name.trim().toLowerCase();
    return byName.get(key) ?? byFirstName.get(key) ?? null;
  };

  const scenes = raw.scenes.map((s, sceneIdx) => {
    const charactersInScene: Character[] = [];
    const addChar = (c: Character) => {
      if (!charactersInScene.some((x) => x.id === c.id)) charactersInScene.push(c);
    };

    for (const name of s.charactersInSceneNames ?? []) {
      const c = resolveName(name);
      if (c) addChar(c);
      else warnings.push(`Scene ${sceneIdx + 1} "${s.title}": unknown character "${name}" — dropped from cast.`);
    }

    const frames: Frame[] = (s.frames ?? []).map((f, frameIdx) => {
      let dialogue: Frame["dialogue"] = null;
      const speakerName = f.dialogueCharacterName?.trim();
      const line = f.dialogueLine?.trim();

      if (speakerName && line) {
        const speaker = resolveName(speakerName);
        if (speaker) {
          dialogue = { character: speaker.name, line };
          // A speaking character not listed as present is still cast into the
          // scene, rather than silently dropping their line to keep the list clean.
          addChar(speaker);
        } else {
          warnings.push(
            `Scene ${sceneIdx + 1} frame ${frameIdx + 1}: dialogue attributed to unknown "${speakerName}" — kept as action text instead of a spoken line.`
          );
        }
      }

      const present = (f.charactersPresent ?? [])
        .map((n) => resolveName(n)?.name)
        .filter((n): n is string => Boolean(n));
      for (const name of present) {
        const c = resolveName(name);
        if (c) addChar(c);
      }

      return {
        label: f.label.trim() || `frame ${frameIdx + 1}`,
        shotType: f.shotType.trim() || "Medium shot",
        lens: null,
        charactersPresent: present.length ? present : undefined,
        action:
          dialogue || !speakerName
            ? f.action.trim()
            : `${f.action.trim()} ${speakerName}: "${line}"`.trim(),
        dialogue,
        noDialogueSound: dialogue ? null : orNull(f.noDialogueSound ?? ""),
      };
    });

    if (!frames.length) warnings.push(`Scene ${sceneIdx + 1} "${s.title}" has no frames.`);
    if (!charactersInScene.length) {
      warnings.push(`Scene ${sceneIdx + 1} "${s.title}" has no recognised characters — video generation will need a cast.`);
    }

    return {
      id: String(sceneIdx + 1),
      title: s.title.trim() || `Scene ${sceneIdx + 1}`,
      durationSeconds: estimateSceneDuration(frames),
      location: s.location.trim(),
      backgroundCustomers: orNull(s.backgroundCustomers ?? ""),
      screenLock: orNull(s.screenLock ?? ""),
      charactersInScene,
      frames,
      pacingOverride: null, // filled in below, from the measured words/sec
      voiceDirections: Object.fromEntries(
        (s.voiceDirections ?? [])
          .map((v) => [resolveName(v.characterName)?.name ?? null, v.direction.trim()] as const)
          .filter((e): e is readonly [string, string] => Boolean(e[0] && e[1]))
      ),
    };
  });

  const scenario = { title: raw.title?.trim() || "Untitled", characters, scenes };
  const parsed = ScenarioSchema.safeParse(scenario);
  if (!parsed.success) {
    throw new Error(
      `Parsed brief did not match the scenario schema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`
    );
  }

  // A brief's scenes are written at story length, not clip length — split them into
  // generatable units before anything downstream sees them.
  const normalized = normalizeScenario(parsed.data);
  return { scenario: normalized.scenario, warnings: [...warnings, ...normalized.warnings] };
}
