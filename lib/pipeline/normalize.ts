import { splitSceneIntoUnits, pacingOverrideFor, MAX_UNIT_SECONDS } from "./timing";
import type { Scenario } from "./types";

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
      scenes.push(
        unit.pacingOverride
          ? unit
          : { ...unit, pacingOverride: pacingOverrideFor(unit.frames, unit.durationSeconds) }
      );
    }
  }

  const dense = scenes.filter((s) => s.pacingOverride).length;
  if (dense) warnings.push(`${dense} scene(s) have dense dialogue and were given a brisk-delivery pacing directive.`);

  return { scenario: { ...scenario, scenes }, warnings };
}
