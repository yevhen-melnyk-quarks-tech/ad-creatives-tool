import { writeFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { run, probe, exists, durationOf, videoInfo, freeBytes } from "./ffmpeg";
import { humanBytes } from "../paths";

// Delivered at 1080x1920, the resolution the reference ad ships at, not the video
// model's native 720x1280. At 720p the logo had only 150px of detail; upscaled ~1.6x
// on a phone its curves and the bolt's diagonals aliased badly enough to read as a
// corrupted graphic. Everything drawn here rasterises at 1.5x instead.
const W = 1080;
const H = 1920;
const S = H / 1280; // pixel geometry below was measured off the reference at 720 wide
const px = (n: number) => Math.round(n * S);
const CTA_SECONDS = 5;

// One preset for every encode in this file. The two outputs that get stream-copied
// together at the end must agree on codec parameters, and identical presets is the
// cheapest way to guarantee that.
const X264 = ["-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p"];
// Likewise one audio format: the clips carry the video model's 32 kHz track, the CTA
// is synthesised silence, and the final concat can only copy if both already match.
const AAC = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];

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
  /** Called with a 0..1 fraction during the long encode, for the job progress bar. */
  onProgress?: (fraction: number, label: string) => void;
};

export type AssembleResult = {
  finalPath: string;
  /** Localization master: same footage and audio, no burned text of any kind. */
  cleanPath: string;
  storyDurationSeconds: number;
  totalDurationSeconds: number;
};

/**
 * Concatenates the scene clips and burns captions, the legal descriptor and the CTA.
 *
 * The pipeline is arranged around two constraints that are easy to miss:
 *
 * **One full-length encode, not three.** An earlier version wrote a concatenated base,
 * re-encoded it once for the localization master, again for captions, and a third time
 * to append the CTA — three passes over the same three and a half minutes, and roughly
 * 520 MB of files for a 130 MB deliverable. Now the story is encoded exactly once; the
 * localization master and the final cut are stream copies.
 *
 * **Clips are not all the same size.** The resolution selector means a project can hold
 * 720x1280 clips alongside 480p ones (which Seedance returns as 496x864). A stream-copy
 * concat of those yields a file with a mid-stream resolution change: ffmpeg rescales it
 * silently, but browsers and editors are not obliged to, so the localization master
 * would have been quietly unusable. Odd-sized clips are conformed first.
 */
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
    onProgress,
  } = opts;

  if (clipPaths.length === 0) throw new Error("assembleFinal: no clips supplied");

  // A failed run leaves full-length intermediates behind, and on a small volume those
  // are exactly what makes the retry fail too. Start from an empty work directory.
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  // ── 0. Space check ───────────────────────────────────────────────────────────
  // The captioned story and the final cut are both roughly the size of the source
  // footage and briefly coexist, and the localization master is one more copy. Failing
  // here with a number beats dying two minutes into an encode with a truncated file.
  const clipBytes = (await Promise.all(clipPaths.map((p) => stat(p).then((s) => s.size)))).reduce((a, b) => a + b, 0);
  // 2.4x measured, not guessed: 121 MB of clips produced a 162 MB final cut and a
  // 127 MB localization master, and both are kept. Add the conformed copies of any
  // odd-sized clips and the peak lands a little under 2.4x.
  const needBytes = Math.round(clipBytes * 2.4);
  const free = await freeBytes(workDir);
  if (free < needBytes) {
    throw new Error(
      `Not enough disk space to assemble: ${humanBytes(free)} free, about ${humanBytes(needBytes)} needed ` +
        `for a final cut and a localization master built from ${humanBytes(clipBytes)} of clips. ` +
        `Delete other projects, use "Free up space" to drop working files, or grow the volume.`
    );
  }

  // ── 1. Conform clip geometry ─────────────────────────────────────────────────
  onLog?.(`Checking ${clipPaths.length} clips...`);
  const infos = await Promise.all(clipPaths.map((p) => videoInfo(p)));
  const tally = new Map<string, number>();
  for (const i of infos) tally.set(`${i.width}x${i.height}`, (tally.get(`${i.width}x${i.height}`) ?? 0) + 1);
  const [targetKey] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  const [tw, th] = targetKey.split("x").map(Number);

  const odd = infos.filter((i) => i.width !== tw || i.height !== th).length;
  if (odd) onLog?.(`  ${tally.size} sizes present; conforming ${odd} clip(s) to ${targetKey}`);

  const sourcePaths: string[] = [];
  for (const [i, clip] of clipPaths.entries()) {
    const info = infos[i];
    if (info.width === tw && info.height === th) {
      sourcePaths.push(clip);
      continue;
    }
    // Scale to cover and crop, rather than stretch or pad. 496x864 is 2% wider in
    // aspect than 720x1280; padding would put visible bars mid-ad, while a crop takes
    // ~2% off the sides where nothing sits. Audio is copied so the clip's duration is
    // untouched — caption cues are force-aligned against these exact lengths.
    const out = path.join(workDir, `conformed_${i}.mp4`);
    await run(
      [
        "-y", "-i", clip,
        "-vf", `scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th},setsar=1`,
        ...X264, "-c:a", "copy", out,
      ],
      `conform clip ${i + 1}`
    );
    sourcePaths.push(out);
  }

  const listPath = path.join(workDir, "concat_list.txt");
  await writeFile(listPath, sourcePaths.map((f) => `file '${path.resolve(f)}'`).join("\n"));
  const storyDuration = infos.reduce((a, i) => a + i.seconds, 0);
  onLog?.(`  story: ${storyDuration.toFixed(2)}s`);

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

  // ── 3. Closing still ────────────────────────────────────────────────────────
  // The CTA is built from a FROZEN final frame, not a replay of the last clip's tail:
  // replaying it made the closing beat play twice, and the CTA text sat over moving
  // footage until the blur ramped in.
  onLog?.("Grabbing the closing frame...");
  const lastFrame = path.join(workDir, "lastframe.png");
  const lastClip = sourcePaths[sourcePaths.length - 1];
  const lastClipDuration = await durationOf(lastClip);
  // Seek from an absolute offset. `-sseof -0.1` decoded zero frames ("Output file is
  // empty") — the end-relative seek landed past the final frame, and ffmpeg still
  // exited 0, so the failure only surfaced later as a missing input.
  //
  // Grabbed from the last CLIP, before any text is burned: taken from a captioned
  // frame, the disclaimer baked into the still and the blur ramp smeared it into a grey
  // ghost.
  await run(
    [
      "-y", "-ss", Math.max(0, lastClipDuration - 0.25).toFixed(3), "-i", lastClip,
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

  // ── 4. The single encode ─────────────────────────────────────────────────────
  // Story and CTA are joined inside one filter graph, so the only file this writes is
  // the deliverable. Rendering the story to its own file first and stream-copying the
  // CTA onto it also works and is easier to read, but it puts two full-length files on
  // disk at once — 322 MB for a 162 MB result, which does not fit the deployed volume.
  //
  // Every time expression below sits UPSTREAM of the concat, so `t` and `T` are
  // relative to the CTA's own start, which is what the ramps and the bob want.
  const filter = [
    `[0:v]scale=${W}:${H}:flags=lanczos,setsar=1${
      hasCaptions
        ? `,subtitles='${esc(srtPath)}':fontsdir='${esc(path.dirname(FONT_BOLD))}':force_style='${captionStyle}'`
        : ""
    }[sv]`,
    // The clips carry the video model's 32 kHz track; concat needs one rate throughout.
    `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[sa]`,

    // Progressive blur ramp. boxblur cannot do this alone — it rejects the time
    // variable `t` outright, accepting only static radii. So blur a copy statically
    // and cross-dissolve clear -> blurred with `blend`, whose expressions DO support
    // time (T). Commas inside the expression must be escaped or the parser splits them.
    `[1:v]fps=24,setsar=1,split=2[clear][toblur]`,
    `[toblur]boxblur=luma_radius=${px(18)}:luma_power=2[blurred]`,
    `[clear][blurred]blend=all_expr='A*(1-min(1\\,T/1.1))+B*min(1\\,T/1.1)'[bg]`,
    `[2:v]scale=${logoSize}:${logoSize}[logo]`,
    `[bg][logo]overlay=x=${logoX}:y=${rowY}:enable='gte(t,0.35)'[withlogo]`,
    // Text is right-aligned to the logo via drawtext's text_w so the pair stays
    // centred as a block regardless of the word used.
    `[withlogo]drawtext=fontfile='${esc(FONT_BOLD)}':textfile='${esc(ctaTxt)}':fontsize=${px(76)}:fontcolor=white:x=${logoX - px(30)}-text_w:y=${rowY + px(30)}:shadowx=${px(2)}:shadowy=${px(2)}:shadowcolor=black@0.5:enable='gte(t,0.35)'[withtext]`,
    // Chevrons bob to draw the eye toward the click target. Drawn as a PNG because
    // text glyphs rendered as literal letter "V"s. overlay's y accepts time
    // expressions, so a sine on t animates it.
    `[3:v]scale=${px(240)}:-1[chev]`,
    `[withtext][chev]overlay=x=(W-w)/2:y='${chevBaseY}+${px(16)}*sin(2*PI*t*1.3)':enable='gte(t,0.7)'[cv]`,
    `[4:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[ca]`,

    `[sv][sa][cv][ca]concat=n=2:v=1:a=1[jv][ja]`,
    // The descriptor is drawn AFTER the join, once, over both halves. The reference ad
    // drops it on the CTA, but keeping the AI disclosure across the whole ad is the
    // safer call and costs nothing visually — and one pass means the story's burned
    // text and the CTA's cannot drift apart.
    `[jv]${discFilters.join(",")}[vout]`,
  ].join(";");

  onLog?.("Rendering the final cut (captions, descriptor, CTA) — the long step...");
  await mkdir(path.dirname(outPath), { recursive: true });
  await run(
    [
      "-y",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-loop", "1", "-t", String(CTA_SECONDS), "-i", lastFrame,
      "-i", LOGO,
      "-i", CHEVRONS,
      "-f", "lavfi", "-t", String(CTA_SECONDS), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-filter_complex", filter,
      "-map", "[vout]", "-map", "[ja]",
      "-r", "24",
      ...X264, ...AAC,
      "-movflags", "+faststart",
      outPath,
    ],
    "final render",
    {
      // A three-and-a-half minute 1080x1920 encode on two threads is comfortably
      // longer than the old 15-minute ceiling, which would have SIGKILLed it.
      timeoutMs: 60 * 60_000,
      totalSeconds: storyDuration + CTA_SECONDS,
      onProgress: (f) => onProgress?.(f, "Rendering final cut"),
    }
  );

  const total = parseFloat(await probe(outPath, "format=duration"));

  // ── 5. Localization master ───────────────────────────────────────────────────
  // The story with NO burned text of any kind, at the clips' native resolution: a
  // stream copy of the same conformed footage the final cut was built from. It carries
  // no English, so a translated or re-voiced cut starts here.
  //
  // Built last, and only after the intermediates are gone, so peak disk stays at one
  // deliverable plus one working copy rather than all of them at once. The CTA is
  // excluded rather than included-without-text: without its text it is just a blurred
  // still, cheaper to re-render per locale than to patch over the English one.
  const cleanPath = path.join(path.dirname(outPath), "MASTER_clean.mp4");
  await rm(lastFrame, { force: true });

  onLog?.("Writing localization master (no burned text)...");
  await run(
    ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", cleanPath],
    "clean master"
  );
  await rm(workDir, { recursive: true, force: true });

  onLog?.(`DONE -> ${outPath} (${total.toFixed(2)}s)`);
  return {
    finalPath: outPath,
    cleanPath,
    storyDurationSeconds: storyDuration,
    totalDurationSeconds: total,
  };
}
