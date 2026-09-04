import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fetchRetry, readJson } from "./http";
import type { Usage } from "./pricing";
import { reportUsage } from "./usageTracker";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

// Image generation (character cards, storyboard sheets) and vision analysis (the QA
// critics) are different models on the same key.
export const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-image-preview";
export const VISION_MODEL = process.env.GEMINI_VISION_MODEL ?? "gemini-3.1-pro-preview";
export const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL ?? "gemini-3.1-pro-preview";

function apiKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY is not set");
  return k;
}

// Ordinary domestic-drama storyboards (a parent leaving with a suitcase, a child
// present) came back blockReason: PROHIBITED_CONTENT with zero output tokens. Without
// relaxing this, QA silently loses coverage on exactly the emotionally-loaded scenes.
const SAFETY_SETTINGS = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" }));

type InlineImage = { mimeType: string; data: string };

const toInline = async (filePath: string): Promise<InlineImage> => ({
  mimeType: filePath.endsWith(".png") ? "image/png" : "image/jpeg",
  data: (await readFile(filePath)).toString("base64"),
});

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string; inlineData?: InlineImage }[] } }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
};

// Every call reports what it consumed so the caller can price it. Without this the
// project spend figure silently excluded all image generation and all agent calls.
const usageOf = (json: GeminiResponse, images: number): Usage => ({
  promptTokens: json.usageMetadata?.promptTokenCount ?? 0,
  outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
  images,
});

/** Generates an image and writes it to `outPath`. Reference images steer consistency. */
export async function generateImage(opts: {
  prompt: string;
  outPath: string;
  referencePaths?: string[];
  onLog?: (m: string) => void;
  onUsage?: (u: Usage) => void;
}): Promise<void> {
  const parts: ({ text: string } | { inlineData: InlineImage })[] = [{ text: opts.prompt }];
  for (const ref of opts.referencePaths ?? []) parts.push({ inlineData: await toInline(ref) });

  const res = await fetchRetry(
    `${BASE}/models/${IMAGE_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": apiKey(), "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
        safetySettings: SAFETY_SETTINGS,
      }),
    },
    4,
    "generateImage",
    opts.onLog
  );

  const json = await readJson<GeminiResponse>(res, "Image generation");
  const image = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  // Reported before the failure checks below: a blocked or empty response is still
  // billed for the tokens it consumed, so skipping it would under-count spend.
  const imageUsage = usageOf(json, image ? 1 : 0);
  opts.onUsage?.(imageUsage);
  reportUsage(imageUsage, "image");

  if (json.promptFeedback?.blockReason) {
    throw new Error(`Image generation blocked: ${json.promptFeedback.blockReason}`);
  }
  if (!image) throw new Error("Image generation returned no image part");

  await mkdir(path.dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, Buffer.from(image.data, "base64"));
}

/**
 * Structured vision/text call. `schema` is a Gemini responseSchema; temperature is 0
 * because these are judgements, not creative output — though note that even at 0 the
 * verdicts on borderline details are not perfectly reproducible.
 */
export async function generateStructured<T>(opts: {
  prompt: string;
  imagePaths?: string[];
  schema: Record<string, unknown>;
  model?: string;
  /** Cost-ledger label for this call, e.g. "critic" or "repair". */
  label?: string;
  onLog?: (m: string) => void;
  onUsage?: (u: Usage) => void;
}): Promise<T> {
  const parts: ({ text: string } | { inlineData: InlineImage })[] = [{ text: opts.prompt }];
  for (const p of opts.imagePaths ?? []) parts.push({ inlineData: await toInline(p) });

  const res = await fetchRetry(
    `${BASE}/models/${opts.model ?? VISION_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": apiKey(), "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: opts.schema,
        },
        safetySettings: SAFETY_SETTINGS,
      }),
    },
    4,
    "generateStructured",
    opts.onLog
  );

  const json = await readJson<GeminiResponse>(res, "Structured generation");
  const agentUsage = usageOf(json, 0);
  opts.onUsage?.(agentUsage);
  reportUsage(agentUsage, opts.label ?? "agent");
  if (json.promptFeedback?.blockReason) {
    throw new Error(`Blocked: ${json.promptFeedback.blockReason}`);
  }
  const text = json.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
  if (!text) throw new Error("Structured generation returned no text part");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Structured generation returned unparseable JSON: ${text.slice(0, 250)}`);
  }
}
