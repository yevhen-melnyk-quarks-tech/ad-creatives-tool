/**
 * The three legal descriptors from the brief, verbatim.
 *
 * Which one applies is a compliance decision the brief makes, not something to infer:
 * type 2 is required when the creative shows a person, type 1 when it is a fictional
 * story without one, type 3 when it is neither. The pipeline previously hardcoded
 * type 2 for every project.
 *
 * `bold` is rendered on its own line above `body`, matching the reference ad, which
 * sets "AI-generated." heavier than the sentence beneath it.
 */
export type DescriptorType = 1 | 2 | 3;

export const DESCRIPTORS: Record<DescriptorType, { name: string; bold: string; body: string }> = {
  1: {
    name: "Fictional story, no person shown",
    bold: "",
    body: "Fictional story. Results not typical and may vary.",
  },
  2: {
    name: "Fictional story showing a person",
    bold: "AI-generated.",
    body: "Fictional story. Results not typical and may vary.",
  },
  3: {
    name: "Advertising message only, no person and no fictional story",
    bold: "",
    body: "Results not typical and may vary.",
  },
};

export const isDescriptorType = (n: unknown): n is DescriptorType => n === 1 || n === 2 || n === 3;

/** Full descriptor text on one line, for display and for an editable field. */
export const descriptorText = (type: DescriptorType): string => {
  const d = DESCRIPTORS[type];
  return d.bold ? `${d.bold} ${d.body}` : d.body;
};

/**
 * Splits an edited descriptor back into the two rendered lines.
 *
 * Only "AI-generated." is promoted to the bold line, because that is the one the
 * reference ad emphasises; anything else is rendered as a single regular line rather
 * than guessing at where a custom sentence should break.
 */
export function splitDescriptor(text: string): { bold: string; body: string } {
  const trimmed = text.trim();
  const m = /^AI-generated\.\s*/i.exec(trimmed);
  return m ? { bold: "AI-generated.", body: trimmed.slice(m[0].length).trim() } : { bold: "", body: trimmed };
}
