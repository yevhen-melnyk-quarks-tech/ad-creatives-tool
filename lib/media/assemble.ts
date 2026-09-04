import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { run, probe, exists, durationOf } from "./ffmpeg";

// Delivered at 1080x1920, the resolution the reference ad ships at, not the video
// model's native 720x1280. At 720p the logo had only 150px of detail; upscaled ~1.6x
// on a phone its curves and the bolt's diagonals aliased badly enough to read as a
// corrupted graphic. Everything drawn here rasterises at 1.5x instead.
const W = 1080;
const H = 1920;
const S = H / 1280; // pixel geometry below was measured off the reference at 720 wide
const px = (n: number) => Math.round(n * S);
const CTA_SECONDS = 5;

const ASSETS = path.join(process.cwd(), "assets");
const FONT_BOLD = path.join(ASSETS, "fonts", "Roboto-Bold.ttf");
const FONT_REG = path.join(ASSETS, "fonts", "Roboto-Regular.ttf");
// Rasterised from the brand SVG, NOT from icon-512.png: those PNG exports place the
// bolt at 29.4%/8.4% left/right and 25.8%/1.4% top/bottom, shoving it into the
// bottom-right corner. This one is centred at 26.6%/26.6%.
const LOGO = path.join(ASSETS, "growli_logo.png");
const CHEVRONS = path.join(ASSETS, "chevrons.png");

// drawtext/subtitles take filter-graph paths, where ':' and '\' are syntax.
const esc = (p: string) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

export type AssembleOptions = {
  clipPaths: string[];
  srtPath: string;
  outPath: string;
  workDir: string;
  disclaimerBold?: string;
  disclaimerRegular?: string;
  ctaText?: string;
  onLog?: (m: string) => void;
};

export type AssembleResult = {
  finalPath: string;
  /** Localization master: same footage and audio, no burned text of any kind. */
  cleanPath: string;
  storyDurationSeconds: number;
  totalDurationSeconds: number;
};

export async function assembleFinal(opts: AssembleOptions): Promise<AssembleResult> {
  const {
    clipPaths,
    srtPath,
    outPath,
    workDir,
    disclaimerBold = "AI-generated.",
    disclaimerRegular = "Fictional story. Results not typical and may vary.",
    ctaText = "TRY NOW",
    onLog,
  } = opts;

  if (clipPaths.length === 0) throw new Error("assembleFinal: no clips supplied");
  await mkdir(workDir, { recursive: true });

  // ── 1. Concat ────────────────────────────────────────────────────────────────
  onLog?.(`Concatenating ${clipPaths.length} clips...`);
  const listPath = path.join(workDir, "concat_list.txt");
  await writeFile(listPath, clipPaths.map((f) => `file '${path.resolve(f)}'`).join("\n"));
  const basePath = path.join(workDir, "01_base.mp4");
  await run(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", basePath], "concat");
  const baseDuration = await durationOf(basePath);
  onLog?.(`  base: ${baseDuration.toFixed(2)}s`);

  // ── 1b. Clean localization master ───────────────────────────────────────────
  // The story at delivery resolution with NO burned text: no captions, no
  // disclaimer, no CTA. Everything this omits is English and has to be redone per
  // language anyway, so this is the artifact a localized cut is built from.
  //
  // The CTA is excluded rather than included-without-text because without its text it
  // is just a blurred still — it is cheaper to re-render per locale from the logo and
  // a translated label than to try to patch over the English one.
  const cleanPath = path.join(path.dirname(outPath), "MASTER_clean.mp4");
  onLog?.("Rendering clean master (no captions, no disclaimer, no CTA)...");
  await run(
    [
      "-y", "-i", basePath,
      "-vf", `scale=${W}:${H}:flags=lanczos`,
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "copy", cleanPath,
    ],
    "clean master"
  );

  // ── 2. Captions + disclaimer ─────────────────────────────────────────────────
  // Values are ASS script units: SRT-sourced subtitles lay out against PlayResY=288,
  // NOT pixels, so everything scales by H/288 on render. A pixel-scale MarginV once
  // put the text entirely off-frame.
  //
  // Sizes measured off the reference ad rather than guessed. Rescaled to 720 wide, its
  // captions are 36px tall with a 7px dark edge (ratio 0.19). A first pass at
  // FontSize=21 rendered 59px tall with a 9px edge — a proportionally *thinner*
  // outline, but on letters 64% larger, so the black edge read as a heavy slab. The
  // fix was the font size, not the outline.
  const captionStyle = [
    "FontName=Roboto",
    "FontSize=16",
    "PrimaryColour=&H00FFFFFF",
    "OutlineColour=&H00000000",
    "Outline=1.0",
    "Shadow=0.6",
    "BackColour=&H80000000",
    "Bold=1",
    "BorderStyle=1",
    "Alignment=2",
    // Reference sits the caption baseline at y≈950 of 1280 (74% down).
    "MarginV=70",
  ].join(",");

  // Descriptor types 1 and 3 have no bold prefix, only a single sentence. Rather than
  // burning a blank line above it, the body moves up into the bold line's position so
  // the block sits where the reference ad puts it either way.
  const hasBold = Boolean(disclaimerBold.trim());
  const discLines: { file: string; text: string; bold: boolean; y: number }[] = hasBold
    ? [
        { file: "disc1.txt", text: disclaimerBold, bold: true, y: Math.round(H * 0.795) },
        { file: "disc2.txt", text: disclaimerRegular, bold: false, y: Math.round(H * 0.822) },
      ]
    : [{ file: "disc2.txt", text: disclaimerRegular, bold: false, y: Math.round(H * 0.795) }];

  for (const l of discLines) await writeFile(path.join(workDir, l.file), l.text, "utf-8");
  const discFilters = discLines.map(
    (l) =>
      `drawtext=fontfile='${esc(l.bold ? FONT_BOLD : FONT_REG)}':textfile='${esc(path.join(workDir, l.file))}':fontsize=${px(l.bold ? 17 : 16)}:fontcolor=white:x=(w-text_w)/2:y=${l.y}:shadowx=${px(1)}:shadowy=${px(1)}:shadowcolor=black@0.6`
  );


  const hasCaptions = await exists(srtPath);
  if (!hasCaptions) onLog?.(`  (no captions.srt — burning disclaimer only)`);

  // Upscale BEFORE the overlays so text rasterises at delivery resolution rather than
  // being scaled up as a bitmap afterwards.
  const vf = [
    `scale=${W}:${H}:flags=lanczos`,
    ...(hasCaptions
      ? [`subtitles='${esc(srtPath)}':fontsdir='${esc(path.dirname(FONT_BOLD))}':force_style='${captionStyle}'`]
      : []),
    ...discFilters,
  ].join(",");

  const storyPath = path.join(workDir, "02_story.mp4");
  onLog?.("Burning captions + disclaimer...");
  await run(
    ["-y", "-i", basePath, "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "copy", storyPath],
    "captions"
  );

  // ── 3. CTA outro ─────────────────────────────────────────────────────────────
  // Built from a FROZEN final frame, not a replay of the last clip's tail: replaying
  // it made the closing beat play twice, and the CTA text sat over moving footage
  // until the blur ramped in.
  onLog?.("Building CTA outro (frozen final frame)...");
  const lastFrame = path.join(workDir, "lastframe.png");
  // Seek from an absolute offset. `-sseof -0.1` decoded zero frames ("Output file is
  // empty") — the end-relative seek landed past the final frame, and ffmpeg still
  // exited 0, so the failure only surfaced later as a missing input.
  //
  // Grabbed from the PRE-caption base: taken from the captioned story, the burned
  // disclaimer baked into the still and the blur ramp smeared it into a grey ghost.
  await run(
    [
      "-y", "-ss", (baseDuration - 0.25).toFixed(3), "-i", basePath,
      "-frames:v", "1", "-vf", `scale=${W}:${H}:flags=lanczos`, "-update", "1", lastFrame,
    ],
    "grab last frame"
  );
  if (!(await exists(lastFrame))) throw new Error("Failed to grab the closing frame — cannot build the CTA");

  const ctaTxt = path.join(workDir, "cta.txt");
  await writeFile(ctaTxt, ctaText, "utf-8");

  // Geometry measured off the reference ad's CTA, rescaled from 720 wide:
  //   logo tile x 495-645, y 447-595 (150px square); "TRY NOW" cap height 55px ending
  //   at x 465 (30px gap before the logo); chevrons y 675-890, centred.
  const logoSize = px(150);
  const rowY = px(447);
  const logoX = px(490);
  const chevBaseY = rowY + px(228);

  const ctaFilter = [
    // Progressive blur ramp. boxblur cannot do this alone — it rejects the time
    // variable `t` outright, accepting only static radii. So blur a copy statically
    // and cross-dissolve clear -> blurred with `blend`, whose expressions DO support
    // time (T). Commas inside the expression must be escaped or the parser splits them.
    `[0:v]split=2[clear][toblur]`,
    `[toblur]boxblur=luma_radius=${px(18)}:luma_power=2[blurred]`,
    `[clear][blurred]blend=all_expr='A*(1-min(1\\,T/1.1))+B*min(1\\,T/1.1)'[bg]`,
    `[1:v]scale=${logoSize}:${logoSize}[logo]`,
    `[bg][logo]overlay=x=${logoX}:y=${rowY}:enable='gte(t,0.35)'[withlogo]`,
    // Text is right-aligned to the logo via drawtext's text_w so the pair stays
    // centred as a block regardless of the word used.
    `[withlogo]drawtext=fontfile='${esc(FONT_BOLD)}':textfile='${esc(ctaTxt)}':fontsize=${px(76)}:fontcolor=white:x=${logoX - px(30)}-text_w:y=${rowY + px(30)}:shadowx=${px(2)}:shadowy=${px(2)}:shadowcolor=black@0.5:enable='gte(t,0.35)'[withtext]`,
    // Disclaimer redrawn crisply. The reference drops it on the CTA, but keeping the
    // AI disclosure across the whole ad is the safer call and costs nothing visually.
    // Same descriptor block, redrawn crisply over the frozen frame.
    ...discFilters.map((f, i) => {
      const inLabel = i === 0 ? "withtext" : `withd${i}`;
      const outLabel = i === discFilters.length - 1 ? "withdisc" : `withd${i + 1}`;
      return `[${inLabel}]${f}[${outLabel}]`;
    }),
    // Chevrons bob to draw the eye toward the click target. Drawn as a PNG because
    // text glyphs rendered as literal letter "V"s. overlay's y accepts time
    // expressions, so a sine on t animates it.
    `[2:v]scale=${px(240)}:-1[chev]`,
    `[withdisc][chev]overlay=x=(W-w)/2:y='${chevBaseY}+${px(16)}*sin(2*PI*t*1.3)':enable='gte(t,0.7)'[vout]`,
  ].join(";");

  const ctaPath = path.join(workDir, "03_cta.mp4");
  await run(
    [
      "-y",
      "-loop", "1", "-t", String(CTA_SECONDS), "-i", lastFrame,
      "-i", LOGO,
      "-i", CHEVRONS,
      "-f", "lavfi", "-t", String(CTA_SECONDS), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-filter_complex", ctaFilter,
      "-map", "[vout]", "-map", "3:a",
      "-r", "24",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-shortest", ctaPath,
    ],
    "cta"
  );

  // ── 4. Final concat ──────────────────────────────────────────────────────────
  // Re-encoded via the concat filter rather than stream-copied: the CTA is a fresh
  // encode while the story carries the video model's own 32kHz audio, so a copy concat
  // risks A/V drift.
  onLog?.("Appending CTA and finalising...");
  await mkdir(path.dirname(outPath), { recursive: true });
  await run(
    [
      "-y", "-i", storyPath, "-i", ctaPath,
      "-filter_complex",
      `[0:v]scale=${W}:${H},setsar=1[v0];[1:v]scale=${W}:${H},setsar=1[v1];` +
        "[0:a]aresample=48000[a0];[1:a]aresample=48000[a1];" +
        "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]",
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k",
      outPath,
    ],
    "final concat"
  );

  const total = parseFloat(await probe(outPath, "format=duration"));
  onLog?.(`DONE -> ${outPath} (${total.toFixed(2)}s)`);
  return {
    finalPath: outPath,
    cleanPath,
    storyDurationSeconds: baseDuration,
    totalDurationSeconds: total,
  };
}
