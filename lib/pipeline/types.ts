import { z } from "zod";

export const CharacterSchema = z.object({
  id: z.number(),
  name: z.string(),
  /** Short inline identifier used in storyboard captions — long text garbles them. */
  tag: z.string(),
  /** Full appearance/wardrobe text, used in the identity-lock block. */
  description: z.string(),
});

export const FrameSchema = z.object({
  label: z.string(),
  shotType: z.string(),
  lens: z.string().nullable().default(null),
  action: z.string(),
  dialogue: z.object({ character: z.string(), line: z.string() }).nullable().default(null),
  noDialogueSound: z.string().nullable().default(null),
  /**
   * Who is visibly in this frame, named by whoever authored the scene.
   *
   * Optional so hand-pasted scenarios still work, but strongly preferred: deriving
   * this from the action prose is guesswork, and getting it wrong made the identity
   * lock forbid a scene's own protagonist.
   */
  charactersPresent: z.array(z.string()).optional(),
});

export const SceneSchema = z.object({
  id: z.string(),
  title: z.string(),
  durationSeconds: z.number(),
  location: z.string(),
  backgroundCustomers: z.string().nullable().default(null),
  screenLock: z.string().nullable().default(null),
  charactersInScene: z.array(CharacterSchema),
  frames: z.array(FrameSchema),
  pacingOverride: z.string().nullable().default(null),
  voiceDirections: z.record(z.string(), z.string()).default({}),
});

export const ScenarioSchema = z.object({
  title: z.string(),
  characters: z.array(CharacterSchema),
  scenes: z.array(SceneSchema),
});

export type Character = z.infer<typeof CharacterSchema>;
export type Frame = z.infer<typeof FrameSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;

export const totalDuration = (s: Scenario) =>
  s.scenes.reduce((acc, sc) => acc + sc.durationSeconds, 0);
