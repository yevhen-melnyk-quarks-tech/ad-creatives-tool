import { splitSceneIntoUnits, pacingOverrideFor, MAX_UNIT_SECONDS } from "./timing";
import { detectByName } from "./prompts";
import type { Scenario, Scene, Character } from "./types";

/**
 * Brings any scenario into a state the pipeline can actually generate from,
 * whichever way it arrived — parsed from a brief or pasted as JSON.
 *
 * Right now that means one thing: no scene may exceed the video model's hard 15s
 * ceiling. Applied to both ingest paths on purpose, since a hand-pasted scenario can
 * violate the limit just as easily as a parsed one, and the failure would otherwise
 * only surface much later as a rejected paid generation.
 *
 * It is a no-op for scenarios already within the limit, so POC-style scenarios with
 * hand-authored ids like "5-1" pass through untouched.
 */
/**
 * Guarantees a scene's cast covers everyone its own frames refer to.
 *
 * This closes the failure that made a clip star the wrong character. The identity
 * lock states who is present AND explicitly forbids everyone else — "John Carter does
 * NOT appear; never use his face" — so a cast that omits someone the action text has
 * doing something hands the video model a contradiction it cannot satisfy. It resolved
 * it by recasting the one character it was allowed to draw, and the scene's
 * protagonist became his boss.
 *
 * The cast is widened rather than the action text trimmed: the prose is the intent,
 * and silently dropping half a shot's staging would be worse than naming an extra
 * character.
 */
function reconcileCast(scene: Scene, allCharacters: Character[]): { scene: Scene; added: string[] } {
  const cast = [...scene.charactersInScene];
  const added: string[] = [];
  const has = (c: Character) => cast.some((x) => x.id === c.id);

  for (const frame of scene.frames) {
    const referenced = [
      // Anyone the prose names, matched against the FULL project cast — a character
      // missing from the scene cast could never be found by searching it.
      ...detectByName(frame.action, allCharacters),
      // And whoever speaks, who is present by definition.
      ...(frame.dialogue
        ? allCharacters.filter((c) => c.name.toLowerCase() === frame.dialogue!.character.toLowerCase())
        : []),
    ];
    for (const c of referenced) {
      if (has(c)) continue;
      cast.push(c);
      added.push(c.name);
    }
  }

  if (!added.length) return { scene, added };
  // Keep the project's ordering so the lock reads consistently across scenes.
  const ordered = allCharacters.filter((c) => cast.some((x) => x.id === c.id));
  return { scene: { ...scene, charactersInScene: ordered }, added };
}

export function normalizeScenario(scenario: Scenario): { scenario: Scenario; warnings: string[] } {
  const warnings: string[] = [];
  const scenes = [];

  for (const scene of scenario.scenes) {
    const { units, warnings: unitWarnings } = splitSceneIntoUnits(scene);
    warnings.push(...unitWarnings);
    if (units.length > 1) {
      warnings.push(
        `Scene ${scene.id} "${scene.title}" ran past the ${MAX_UNIT_SECONDS}s clip limit and was split into ${units.length} units (${units.map((u) => u.id).join(", ")}).`
      );
    }
    // Applied after splitting, since a unit's words/sec depends on the duration it
    // ended up with — and only where one is not already authored.
    for (const unit of units) {
      const withPacing = unit.pacingOverride
        ? unit
        : { ...unit, pacingOverride: pacingOverrideFor(unit.frames, unit.durationSeconds) };

      // Applied per unit and AFTER splitting, because splitting is what narrows the
      // cast — and that narrowing is where a character referenced by the prose gets
      // dropped.
      const { scene: reconciled, added } = reconcileCast(withPacing, scenario.characters);
      if (added.length) {
        warnings.push(
          `Scene ${reconciled.id}: ${added.join(", ")} ${added.length === 1 ? "is" : "are"} referenced in the action but ${added.length === 1 ? "was" : "were"} missing from the cast — added, or the prompt would have told the video model they do not appear.`
        );
      }
      scenes.push(reconciled);
    }
  }

  const dense = scenes.filter((s) => s.pacingOverride).length;
  if (dense) warnings.push(`${dense} scene(s) have dense dialogue and were given a brisk-delivery pacing directive.`);

  return { scenario: { ...scenario, scenes }, warnings };
}
