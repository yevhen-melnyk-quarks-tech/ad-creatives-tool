"use client";

import { useCallback, useEffect, useState } from "react";
import type { Scenario } from "@/lib/pipeline/types";
import type { CriticReport } from "@/lib/agents/types";
import ThemeToggle from "@/app/ThemeToggle";

type Artifact = {
  kind: string; scene_id: string | null; file_path: string; attempt: number; approved: number;
  prompt_additions: string | null;
};
type SpendRow = { provider: string; operation: string; calls: number; usd: number };
type Note = { kind: string; scene_id: string | null; note: string };
type Disclaimer = {
  type: number; text: string; source: string;
  versions: { label: string; name: string; descriptorType: number }[];
  options: { type: number; name: string }[];
};
type Job = {
  id: string; kind: string; status: string; error: string | null;
  progress: string | null; active_scene: string | null; payload: string | null;
  progress_step: number | null; progress_total: number | null; progress_label: string | null;
};
type QaRow = { stage: string; scene_id: string | null; verdict: string; report: CriticReport };

const KIND_LABEL: Record<string, string> = {
  character_card: "Character card",
  storyboards: "Storyboards",
  storyboard_one: "Storyboard",
  videos: "Videos",
  video_one: "Video",
  captions: "Captions",
  assemble: "Final assembly",
};

const VERDICT_STYLE: Record<string, string> = {
  PASS: "bg-ok-bg text-ok-ink",
  REVIEW: "bg-warn-bg-strong text-warn-ink",
  FAIL: "bg-danger-bg-strong text-danger-ink",
  UNAVAILABLE: "bg-surface-raised text-ink-soft",
  ERROR: "bg-surface-raised text-ink-soft",
};

export default function ProjectWorkspace(props: {
  projectId: string;
  title: string;
  status: string;
  scenario: Scenario | null;
  scenarioError: string | null;
  initialBrief: string;
  initialResolution: "480p" | "720p";
  initialSpendUsd: number;
  initialDiskHuman: string;
}) {
  const { projectId, scenario } = props;

  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [qa, setQa] = useState<QaRow[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [disclaimer, setDisclaimer] = useState<Disclaimer | null>(null);
  const [discDraft, setDiscDraft] = useState<string | null>(null);
  const [savingDisc, setSavingDisc] = useState(false);
  const [spend, setSpend] = useState(props.initialSpendUsd);
  const [spendRows, setSpendRows] = useState<SpendRow[]>([]);
  const [spendOpen, setSpendOpen] = useState(false);
  const [ratesAreDefaults, setRatesAreDefaults] = useState(false);
  const [resolution, setResolution] = useState<"480p" | "720p">(props.initialResolution);
  const [savingRes, setSavingRes] = useState(false);
  const [disk, setDisk] = useState(props.initialDiskHuman);
  const [busy, setBusy] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null);
  const [briefOpen, setBriefOpen] = useState(!scenario);
  const [briefText, setBriefText] = useState(props.initialBrief);
  const [reparsing, setReparsing] = useState(false);
  const [reparseError, setReparseError] = useState<string | null>(null);
  const [reparseWarnings, setReparseWarnings] = useState<string[] | null>(null);

  const refresh = useCallback(async () => {
    const [detail, qaRes] = await Promise.all([
      fetch(`/api/projects/${projectId}`).then((r) => r.json()),
      fetch(`/api/projects/${projectId}/qa`).then((r) => r.json()),
    ]);
    setArtifacts(detail.artifacts ?? []);
    setJobs(detail.jobs ?? []);
    setSpend(detail.spendUsd ?? 0);
    setSpendRows(detail.spendBreakdown ?? []);
    setRatesAreDefaults(Boolean(detail.spendRatesAreDefaults));
    setDisk(detail.diskHuman ?? "0 B");
    setQa(qaRes.reports ?? []);
    setNotes(detail.notes ?? []);
    setDisclaimer(detail.disclaimer ?? null);
    setHasLoaded(true);
  }, [projectId]);

  useEffect(() => {
    void refresh();
    // Jobs run for minutes, so poll rather than making the user reload.
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  async function startJob(kind: string, sceneId?: string, note?: string) {
    setBusy(sceneId ? `${kind}:${sceneId}` : kind);
    await fetch(`/api/projects/${projectId}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, sceneId, note }),
    });
    await refresh();
    setBusy(null);
  }

  async function saveResolution(next: "480p" | "720p") {
    setSavingRes(true);
    setResolution(next);
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoResolution: next }),
    });
    await refresh();
    setSavingRes(false);
  }

  async function saveDisclaimer(patch: { descriptorType?: number | null; disclaimerText?: string | null }) {
    setSavingDisc(true);
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setDiscDraft(null);
    await refresh();
    setSavingDisc(false);
  }

  async function saveNote(kind: string, sceneId: string | null, note: string) {
    await fetch(`/api/projects/${projectId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, sceneId, note }),
    });
    await refresh();
  }

  async function approve(kind: string, sceneId: string | null, approved: boolean) {
    await fetch(`/api/projects/${projectId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, sceneId, approved }),
    });
    await refresh();
  }

  async function reparse() {
    setReparsing(true);
    setReparseError(null);
    setReparseWarnings(null);
    const res = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: briefText }),
    });
    const data = await res.json();
    setReparsing(false);
    if (!res.ok) {
      setReparseError(data.error ?? "Failed to parse brief");
      return;
    }
    if (data.warnings?.length) setReparseWarnings(data.warnings);
    // Scenario, artifacts and approvals all changed server-side (re-parsing clears
    // prior approvals — see the PATCH route) — a client refetch of just jobs/artifacts
    // would leave the page showing the old scenario prop, so reload for real.
    window.location.reload();
  }

  const fileUrl = (p: string) => `/api/projects/${projectId}/file?name=${encodeURIComponent(p.split("/").pop() ?? "")}`;
  const find = (kind: string, sceneId: string | null = null) =>
    artifacts.find((a) => a.kind === kind && a.scene_id === sceneId);
  const qaFor = (stage: string, sceneId: string | null = null) =>
    qa.find((r) => r.stage === stage && r.scene_id === sceneId);
  const noteFor = (kind: string, sceneId: string | null = null) =>
    notes.find((n) => n.kind === kind && n.scene_id === sceneId)?.note ?? "";

  // The RUNNING job specifically, not just the newest unfinished one. Ordering is
  // created_at DESC, so queueing a re-roll while a batch was running made the newer
  // queued job win — and a queued job has no active scene yet, so the badge vanished
  // from every row even though work was in progress.
  const runningJob = jobs.find((j) => j.status === "running");
  const queuedJobs = jobs.filter((j) => j.status === "queued");
  const activeJob = runningJob ?? queuedJobs[queuedJobs.length - 1];

  // A job that fails has to say so where the running banner was, or the only signal is
  // that the banner disappeared — which reads as "finished". jobs is ordered newest
  // first, so this is the most recent failure, shown until it is dismissed or
  // superseded by new work.
  const failedJob = !activeJob && jobs[0]?.status === "failed" && jobs[0].id !== dismissedJobId ? jobs[0] : undefined;

  const sceneOfPayload = (j: Job): string | null => {
    try {
      return (JSON.parse(j.payload ?? "{}") as { sceneId?: string }).sceneId ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Scenes a job is working right now. Parallel generation means several at once, so
   * this is stored as a JSON array — older rows hold a bare scene id, hence the
   * fallback rather than letting a parse failure hide every badge.
   */
  const activeScenesOf = (j: Job | undefined): string[] => {
    if (!j?.active_scene) return [];
    try {
      const parsed = JSON.parse(j.active_scene);
      return Array.isArray(parsed) ? (parsed as string[]) : [String(parsed)];
    } catch {
      return [j.active_scene];
    }
  };
  const card = find("character_card");
  const cardApproved = card?.approved === 1;
  const approvedSheets = artifacts.filter((a) => a.kind === "storyboard" && a.approved === 1).length;

  /** "generating" if the running job is on this scene; "queued" if one is waiting for it. */
  const sceneJobState = (sceneId: string, kinds: string[]): "generating" | "queued" | null => {
    if (runningJob && kinds.includes(runningJob.kind)) {
      const active = activeScenesOf(runningJob);
      if (active.includes(sceneId)) return "generating";
      // A bulk job with scenes in flight is still going to reach this one; one that
      // has not named any scene yet is only just starting.
      if (!sceneOfPayload(runningJob)) return "queued";
    }
    for (const j of queuedJobs) {
      if (!kinds.includes(j.kind)) continue;
      const target = sceneOfPayload(j);
      if (target === sceneId || target === null) return "queued";
    }
    if (busy && kinds.some((k) => busy === `${k}:${sceneId}`)) return "queued";
    return null;
  };

  const sheetsMissing = scenario
    ? scenario.scenes.filter((sc) => !find("storyboard", sc.id)).length
    : 0;
  const videosMissing = scenario
    ? scenario.scenes.filter((sc) => find("storyboard", sc.id)?.approved === 1 && !find("video", sc.id)).length
    : 0;

  return (
    <main className="mx-auto max-w-5xl p-8">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <a href="/" className="text-xs text-ink-subtle transition-opacity active:opacity-60 hover:underline">
            ← All projects
          </a>
          <h1 className="text-2xl font-semibold">{props.title}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs text-ink-subtle">
          <ThemeToggle />
          <span>status: {props.status}</span>
          <span className="relative">
            <button
              onClick={() => setSpendOpen((v) => !v)}
              className="underline transition-opacity active:opacity-60"
              title="Break down by provider and operation"
            >
              spend: ${spend.toFixed(2)}
            </button>
            {spendOpen && (
              <div className="absolute right-0 top-6 z-10 w-80 rounded-lg border border-line-strong bg-surface p-3 text-left shadow-lg">
                <table className="w-full text-xs">
                  <tbody>
                    {spendRows.length === 0 && (
                      <tr>
                        <td className="py-1 text-ink-subtle">Nothing spent yet.</td>
                      </tr>
                    )}
                    {spendRows.map((r) => (
                      <tr key={`${r.provider}:${r.operation}`}>
                        <td className="py-0.5 pr-2">{r.operation}</td>
                        <td className="py-0.5 pr-2 text-ink-subtle">x{r.calls}</td>
                        <td className="py-0.5 text-right tabular-nums">${r.usd.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {ratesAreDefaults && (
                  <p className="mt-2 border-t border-line pt-2 text-xs text-warn-ink-soft">
                    Gemini image and agent costs are <strong>estimates</strong> at built-in default rates. Token
                    counts are real; set GEMINI_IMAGE_USD, GEMINI_INPUT_USD_PER_M and GEMINI_OUTPUT_USD_PER_M to
                    your account&apos;s actual prices for exact figures.
                  </p>
                )}
              </div>
            )}
          </span>
          <span>
            disk: {disk}{" "}
            <button
              onClick={async () => {
                await fetch(`/api/projects/${projectId}?mode=intermediates`, { method: "DELETE" });
                await refresh();
              }}
              className="ml-1 underline transition-opacity active:opacity-60"
              title="Delete working and diagnostic files. Keeps clips and the final video."
            >
              prune
            </button>
          </span>
        </div>
      </header>

      {props.scenarioError && (
        <p className="mb-4 rounded-md bg-danger-bg p-3 text-sm text-danger-ink">{props.scenarioError}</p>
      )}
      <section className="mb-6 rounded-lg border border-line p-4">
        <button
          onClick={() => setBriefOpen((v) => !v)}
          className="flex w-full items-center justify-between text-left text-sm font-medium transition-opacity active:opacity-60"
        >
          <span>Brief {scenario ? "(edit and re-parse)" : "— paste one to begin"}</span>
          <span className="text-xs text-ink-subtle">{briefOpen ? "hide" : "show"}</span>
        </button>
        {briefOpen && (
          <div className="mt-3">
            <textarea
              value={briefText}
              onChange={(e) => setBriefText(e.target.value)}
              placeholder="Paste a creative brief — any language, any shape. An agent splits it into characters and scenes."
              rows={8}
              className="w-full rounded-md border border-line-strong px-3 py-2 font-mono text-xs outline-none focus:border-accent"
            />
            {scenario && (
              <p className="mt-1 text-xs text-warn-ink-soft">
                Re-parsing replaces the current scenario and clears all approvals — regenerated storyboards and videos
                will need re-approving.
              </p>
            )}
            {reparseError && <p className="mt-2 rounded-md bg-danger-bg p-2 text-xs text-danger-ink">{reparseError}</p>}
            {reparseWarnings && (
              <ul className="mt-2 space-y-0.5 rounded-md bg-warn-bg p-2 text-xs text-warn-ink">
                {reparseWarnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            )}
            <Btn small onClick={reparse} busy={reparsing} disabled={!briefText.trim()}>
              {scenario ? "Re-parse scenario" : "Parse brief"}
            </Btn>
          </div>
        )}
      </section>

      {activeJob && <RunningBanner job={activeJob} scenes={activeScenesOf(activeJob)} />}
      {failedJob && (
        <FailedBanner
          job={failedJob}
          onRetry={() => startJob(failedJob.kind, sceneOfPayload(failedJob) ?? undefined)}
          onDismiss={() => setDismissedJobId(failedJob.id)}
        />
      )}

      {scenario && (
        <div className={hasLoaded ? "" : "opacity-50 transition-opacity"}>
          {/* Step 1 — character card */}
          <Step n={1} title="Character card">
            <div className="flex flex-wrap items-start gap-4">
              {card ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={fileUrl(card.file_path)} alt="Character card" className="w-72 rounded border border-line" />
              ) : (
                <div className="h-40 w-72 animate-pulse rounded bg-surface-sunken" />
              )}
              <div className="flex-1 space-y-2">
                <Verdict report={qaFor("character_card")?.report} />
                <div className="flex flex-wrap gap-2">
                  <Btn onClick={() => startJob("character_card")} busy={busy === "character_card"}>
                    {card ? "Regenerate" : "Generate"}
                  </Btn>
                  {card && (
                    <Btn variant={cardApproved ? "muted" : "primary"} onClick={() => approve("character_card", null, !cardApproved)}>
                      {cardApproved ? "Approved ✓" : "Approve"}
                    </Btn>
                  )}
                </div>
                <NoteBox
                  initial={noteFor("character_card", null)}
                  label={card ? "Re-roll with note" : "Generate with note"}
                  busy={busy === "character_card"}
                  onRun={(note) => startJob("character_card", undefined, note)}
                  onClear={() => saveNote("character_card", null, "")}
                />
              </div>
            </div>
          </Step>

          {/* Step 2 — storyboards */}
          <Step n={2} title={`Storyboards (${approvedSheets}/${scenario.scenes.length} approved)`}>
            <Btn
              onClick={() => startJob("storyboards")}
              busy={busy === "storyboards"}
              disabled={!cardApproved || sheetsMissing === 0}
            >
              {sheetsMissing === 0 ? "All generated" : `Generate missing (${sheetsMissing})`}
            </Btn>
            {!cardApproved && <span className="ml-3 text-xs text-ink-subtle">Approve the character card first.</span>}
            {cardApproved && (
              <p className="mt-2 text-xs text-ink-subtle">
                Existing sheets are kept — this only generates scenes that have none. Use a scene&apos;s own Re-roll to
                replace one.
              </p>
            )}

            <div className="mt-4 space-y-3">
              {scenario.scenes.map((scene) => {
                const sheet = find("storyboard", scene.id);
                const report = qaFor("storyboard", scene.id)?.report;
                return (
                  <div key={scene.id} className="flex flex-wrap items-start gap-4 rounded border border-line p-3">
                    {sheet ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={fileUrl(sheet.file_path)} alt={`Scene ${scene.id}`} className="w-56 rounded border border-line" />
                    ) : (
                      <div className="h-24 w-56 animate-pulse rounded bg-surface-sunken" />
                    )}
                    <div className="flex-1 space-y-2">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span>
                          Scene {scene.id} — {scene.title}
                          <span className="ml-2 text-xs font-normal text-ink-subtle">{scene.durationSeconds}s</span>
                          {sheet && sheet.attempt > 1 && (
                            <span className="ml-2 text-xs font-normal text-ink-subtle">attempt {sheet.attempt}</span>
                          )}
                        </span>
                        <JobBadge state={sceneJobState(scene.id, ["storyboards", "storyboard_one"])} />
                      </p>
                      <Verdict report={report} />
                      <AppliedFixes artifact={sheet} />
                      <NoteBox
                        initial={noteFor("storyboard", scene.id)}
                        label={sheet ? "Re-roll with note" : "Generate with note"}
                        busy={busy === `storyboard_one:${scene.id}`}
                        disabled={!cardApproved}
                        onRun={(note) => startJob("storyboard_one", scene.id, note)}
                        onClear={() => saveNote("storyboard", scene.id, "")}
                      />
                      <div className="flex flex-wrap gap-2">
                        {/* Same single-scene job either way — the label just reflects
                            whether there is already a sheet to replace. */}
                        <Btn
                          small
                          onClick={() => startJob("storyboard_one", scene.id)}
                          busy={busy === `storyboard_one:${scene.id}`}
                          disabled={!cardApproved}
                        >
                          {sheet ? "Re-roll" : "Generate"}
                        </Btn>
                        {sheet && (
                          <Btn
                            small
                            variant={sheet.approved ? "muted" : "primary"}
                            onClick={() => approve("storyboard", scene.id, !sheet.approved)}
                          >
                            {sheet.approved ? "Approved ✓" : "Approve"}
                          </Btn>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Step>

          {/* Step 3 — videos */}
          <Step n={3} title="Videos">
            <p className="mb-2 text-xs text-ink-subtle">
              Only approved storyboards are rendered — this gate is what keeps paid renders downstream of the free check.
            </p>

            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-ink-muted">Quality</span>
              <div className="flex gap-1 rounded-md bg-surface-sunken p-0.5 text-xs">
                {(["480p", "720p"] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => saveResolution(r)}
                    disabled={savingRes}
                    className={`rounded px-2.5 py-1 font-medium transition-all active:scale-95 disabled:opacity-50 ${
                      resolution === r ? "bg-surface shadow-sm" : "text-ink-subtle"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <span className="text-xs text-ink-subtle">
                {resolution === "480p"
                  ? "cheaper and faster — good while iterating"
                  : "full quality — use for the final render"}
              </span>
            </div>
            <Btn
              onClick={() => startJob("videos")}
              busy={busy === "videos"}
              disabled={approvedSheets === 0 || videosMissing === 0}
            >
              {approvedSheets === 0
                ? "Approve a storyboard first"
                : videosMissing === 0
                  ? "All approved scenes generated"
                  : `Generate missing (${videosMissing})`}
            </Btn>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {scenario.scenes.map((scene) => {
                const clip = find("video", scene.id);
                const report = qaFor("video_scene", scene.id)?.report;
                const sheetApproved = find("storyboard", scene.id)?.approved === 1;
                return (
                  <div key={scene.id} className="rounded border border-line p-3">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span>
                        Scene {scene.id}
                        <span className="ml-2 text-xs font-normal text-ink-subtle">{scene.durationSeconds}s</span>
                      </span>
                      <JobBadge state={sceneJobState(scene.id, ["videos", "video_one"])} />
                    </p>
                    {clip ? (
                      <video src={fileUrl(clip.file_path)} controls className="mt-2 w-full rounded" />
                    ) : (
                      <div className="mt-2 aspect-[9/16] max-h-48 w-full animate-pulse rounded bg-surface-sunken" />
                    )}
                    <div className="mt-2 space-y-2">
                      <Verdict report={report} />
                      <AppliedFixes artifact={clip} />
                      {/* Gated on this scene's own storyboard approval, so a single
                          paid render cannot bypass the check that "Generate approved
                          scenes" enforces in bulk. */}
                      <Btn
                        small
                        onClick={() => startJob("video_one", scene.id)}
                        busy={busy === `video_one:${scene.id}`}
                        disabled={!sheetApproved}
                      >
                        {clip ? "Re-roll" : "Generate"}
                      </Btn>
                      {sheetApproved && (
                        <NoteBox
                          initial={noteFor("video", scene.id)}
                          label={clip ? "Re-roll with note" : "Generate with note"}
                          busy={busy === `video_one:${scene.id}`}
                          onRun={(note) => startJob("video_one", scene.id, note)}
                          onClear={() => saveNote("video", scene.id, "")}
                        />
                      )}
                      {!sheetApproved && (
                        <p className="text-xs text-ink-subtle">Approve this storyboard first.</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Step>

          {/* Step 4 — captions + assembly */}
          <Step n={4} title="Captions & final assembly">
            {disclaimer && (
              <div className="mb-4 rounded border border-line bg-surface-muted p-3">
                <p className="text-xs font-medium text-ink-soft">
                  Legal descriptor burned into the final cut
                </p>
                <p className="mt-0.5 text-xs text-ink-subtle">
                  Type {disclaimer.type} — {disclaimer.source}
                  {disclaimer.versions.length > 0 && (
                    <>
                      {" · brief lists "}
                      {disclaimer.versions
                        .map((v) => `${v.label}${v.name ? ` (${v.name})` : ""} → type ${v.descriptorType}`)
                        .join(", ")}
                    </>
                  )}
                </p>

                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {disclaimer.options.map((o) => (
                    <button
                      key={o.type}
                      title={o.name}
                      disabled={savingDisc}
                      onClick={() => saveDisclaimer({ descriptorType: o.type, disclaimerText: null })}
                      className={`rounded px-2 py-0.5 text-xs font-medium transition-all active:scale-95 disabled:opacity-50 ${
                        disclaimer.type === o.type ? "bg-accent text-accent-ink" : "bg-surface text-ink-muted border border-line-strong"
                      }`}
                    >
                      Type {o.type}
                    </button>
                  ))}
                  {disclaimer.versions.length > 0 && (
                    <button
                      disabled={savingDisc}
                      onClick={() => saveDisclaimer({ descriptorType: null, disclaimerText: null })}
                      className="ml-1 text-xs text-ink-subtle underline transition-opacity active:opacity-60 disabled:opacity-50"
                      title="Use whichever type the brief's version block selected"
                    >
                      use the brief&apos;s
                    </button>
                  )}
                </div>

                <textarea
                  value={discDraft ?? disclaimer.text}
                  onChange={(e) => setDiscDraft(e.target.value)}
                  rows={2}
                  className="mt-2 w-full rounded border border-line-strong px-2 py-1 text-xs outline-none focus:border-accent"
                />
                <p className="mt-1 text-xs text-ink-subtle">
                  Exactly what gets burned. Edit it if the wording needs to differ; &quot;AI-generated.&quot; is set on
                  its own bolder line, as in the reference ad.
                </p>
                {discDraft !== null && discDraft.trim() !== disclaimer.text && (
                  <div className="mt-1 flex gap-2">
                    <Btn small busy={savingDisc} onClick={() => saveDisclaimer({ disclaimerText: discDraft })}>
                      Save wording
                    </Btn>
                    <button
                      onClick={() => setDiscDraft(null)}
                      className="text-xs text-ink-subtle underline transition-opacity active:opacity-60"
                    >
                      cancel
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Btn onClick={() => startJob("assemble")} busy={busy === "assemble"}>
                Assemble final
              </Btn>
              <Btn variant="muted" onClick={() => startJob("captions")} busy={busy === "captions"}>
                Rebuild captions only
              </Btn>
            </div>
            <p className="mt-2 text-xs text-ink-subtle">
              Assembling builds captions first whenever they are missing or older than a clip, so this is the only
              button you need. Rebuilding captions on their own is for refreshing the transcript without re-rendering
              the video.
            </p>
            <div className="mt-3">
              <Verdict report={qaFor("assembly")?.report} />
            </div>
            {find("final") || props.status === "complete" ? (
              <div className="mt-4 flex flex-wrap gap-6">
                <div>
                  <p className="mb-1 text-xs font-medium text-ink-muted">Final cut</p>
                  <video
                    src={`/api/projects/${projectId}/file?name=FINAL.mp4`}
                    controls
                    playsInline
                    preload="metadata"
                    className="w-72 rounded border border-line"
                  />
                  <a
                    href={`/api/projects/${projectId}/file?name=FINAL.mp4`}
                    download="FINAL.mp4"
                    className="mt-2 inline-block rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink transition-all active:scale-95"
                  >
                    Download FINAL.mp4
                  </a>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-ink-muted">Localization set</p>
                  <p className="mb-2 max-w-xs text-xs text-ink-subtle">
                    The same cut with no burned text, plus the timed script — for translated captions or a
                    re-voiced version.
                  </p>
                  <div className="flex flex-col items-start gap-1 text-xs">
                    {[
                      ["MASTER_clean.mp4", "Clean master (no captions, no disclaimer, no CTA)"],
                      ["transcript.srt", "Transcript, per line with timings"],
                      ["transcript.json", "Transcript as JSON, with word timings"],
                      ["captions.srt", "Burned captions, as used in the final cut"],
                    ].map(([file, label]) => (
                      <a
                        key={file}
                        href={`/api/projects/${projectId}/file?name=${encodeURIComponent(file)}`}
                        className="underline transition-opacity active:opacity-60 hover:text-ink"
                      >
                        {label}
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </Step>
        </div>
      )}
    </main>
  );
}

/**
 * Free-text correction for one artifact, applied to the prompt on the next generation.
 *
 * Local draft state with a save-on-run button rather than autosave: the note is a
 * deliberate instruction, and firing a paid regeneration off a half-typed sentence
 * would be worse than making the user press a button.
 */
function NoteBox({
  initial,
  label,
  busy,
  disabled,
  onRun,
  onClear,
}: {
  initial: string;
  label: string;
  busy: boolean;
  disabled?: boolean;
  onRun: (note: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(Boolean(initial));
  const [text, setText] = useState(initial);

  // Adopt a note saved elsewhere (or cleared by a re-parse) unless the user is
  // mid-edit, so the box does not fight the polling refresh.
  useEffect(() => {
    setText((cur) => (cur === "" || cur === initial ? initial : cur));
  }, [initial]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-ink-subtle underline transition-opacity active:opacity-60"
      >
        + add a note for the next attempt
      </button>
    );
  }

  return (
    <div className="rounded border border-line bg-surface-muted p-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder={"What should change? e.g. \"Mia's hair should be a ponytail, not loose\" or \"remove the logo from the tablets\""}
        className="w-full rounded border border-line-strong px-2 py-1 text-xs outline-none focus:border-accent"
      />
      <div className="mt-1 flex items-center gap-2">
        <Btn small onClick={() => onRun(text)} busy={busy} disabled={disabled || !text.trim()}>
          {label}
        </Btn>
        {initial && (
          <button
            onClick={() => { setText(""); onClear(); }}
            className="text-xs text-ink-subtle underline transition-opacity active:opacity-60"
            title="Forget this note so it is not reapplied"
          >
            clear
          </button>
        )}
        <span className="text-xs text-ink-subtle">
          {initial ? "a note is saved and will be reapplied" : "applied on the next attempt"}
        </span>
      </div>
    </div>
  );
}

/** Inline progress marker, so state is visible without scrolling back up the page. */
/**
 * Sticky status bar for whatever is running.
 *
 * Sticky because it was not: a job's only indicator sat at the top of the page, and
 * pressing a button in step 3 or 4 scrolled it out of view — so the app looked like it
 * had done nothing. It shows the phase, a count where the total is knowable, and the
 * most recent log line, which is the part that actually tells you the run is alive.
 */
function RunningBanner({ job, scenes }: { job: Job; scenes: string[] }) {
  const lines = (job.progress ?? "").trimEnd().split("\n").filter(Boolean);
  const last = lines[lines.length - 1] ?? "starting…";
  const step = job.progress_step;
  const total = job.progress_total;
  const pct = step !== null && total !== null && total > 0 ? Math.round((step / total) * 100) : null;

  return (
    <div className="sticky top-0 z-20 -mx-8 mb-6 border-b border-line bg-surface/95 px-8 py-3 backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-info-dot" />
        <span className="font-medium">{KIND_LABEL[job.kind] ?? job.kind}</span>
        <span className="text-xs text-ink-subtle">
          {job.status === "queued" ? "queued" : job.progress_label ?? "running"}
          {pct !== null && ` · ${step}/${total} (${pct}%)`}
          {scenes.length > 0 && ` · scene ${scenes.join(", ")}`}
        </span>
      </div>

      {pct !== null && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded bg-surface-raised">
          <div className="h-full rounded bg-info-dot transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}

      <p className="mt-1.5 truncate text-xs text-ink-muted" title={last}>
        {last}
      </p>

      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-ink-subtle">full log</summary>
        <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap text-xs text-ink-muted">
          {job.progress ?? ""}
        </pre>
      </details>
    </div>
  );
}

/**
 * Sticky report for a job that failed.
 *
 * Its absence was a real defect, not a missing nicety: the only sign a run had died
 * was the running banner going away, which is indistinguishable from success. Pressing
 * "Assemble final" and watching the status vanish left nothing on screen to say ffmpeg
 * had been killed. The error text is shown in full — these messages name the actual
 * cause (out of memory, out of disk, a timeout) and are what makes the next step
 * obvious.
 */
function FailedBanner({ job, onRetry, onDismiss }: { job: Job; onRetry: () => void; onDismiss: () => void }) {
  return (
    <div className="sticky top-0 z-20 -mx-8 mb-6 border-y border-danger-ink/25 bg-danger-bg px-8 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-danger-ink">{KIND_LABEL[job.kind] ?? job.kind} failed</span>
        <button
          onClick={onRetry}
          className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-accent-ink transition-all active:scale-95"
        >
          Try again
        </button>
        <button
          onClick={onDismiss}
          className="text-xs text-danger-ink underline transition-opacity active:opacity-60"
        >
          dismiss
        </button>
      </div>
      {job.error && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-danger-ink">{job.error}</pre>
      )}
      {job.progress && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-danger-ink/80">log up to the failure</summary>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap text-xs text-ink-muted">{job.progress}</pre>
        </details>
      )}
    </div>
  );
}

function JobBadge({ state }: { state: "generating" | "queued" | null }) {
  if (!state) return null;
  const generating = state === "generating";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
        generating ? "bg-info-bg text-info-ink" : "bg-surface-raised text-ink-muted"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${generating ? "animate-pulse bg-info-dot" : "bg-ink-subtle"}`} />
      {state}
    </span>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8 rounded-lg border border-line p-5">
      <h2 className="mb-3 text-sm font-medium">
        <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent text-xs text-accent-ink">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Verdict({ report }: { report?: CriticReport }) {
  if (!report) return <p className="text-xs text-ink-subtle">No QA run yet.</p>;
  const blocking = report.findings.filter((f) => f.blocking);
  const advisory = report.findings.filter((f) => !f.blocking);

  return (
    <div className="space-y-1">
      <p className="flex items-center gap-2 text-xs">
        <span className={`rounded px-1.5 py-0.5 font-medium ${VERDICT_STYLE[report.verdict] ?? ""}`}>{report.verdict}</span>
        {report.consensus && (
          <span className="text-ink-subtle">
            {report.consensus.failVotes}/{report.consensus.samples} passes flagged it
          </span>
        )}
        <span className="text-ink-muted">{report.summary}</span>
      </p>
      {blocking.map((f, i) => (
        <p key={`b${i}`} className="text-xs text-danger-ink">
          • {f.subject ? `${f.subject}: ` : ""}
          {f.detail}
        </p>
      ))}
      {advisory.length > 0 && (
        <details className="text-xs text-ink-subtle">
          <summary className="cursor-pointer">{advisory.length} advisory note(s)</summary>
          {advisory.map((f, i) => (
            <p key={`a${i}`} className="ml-3 mt-1">
              • {f.detail}
            </p>
          ))}
        </details>
      )}
      {report.verdict !== "PASS" && (
        <p className="text-xs text-ink-subtle">
          {report.verdict === "FAIL"
            ? "Re-roll to retry with these defects fed back into the prompt, or approve anyway if it looks fine to you."
            : report.verdict === "UNAVAILABLE"
              ? "No automated check ran on this one — judge it yourself, then approve or re-roll."
              : "The two QA passes disagreed, so nothing is confirmed — look at the image yourself. Re-roll feeds the notes back in; approve if it reads fine."}
        </p>
      )}
    </div>
  );
}

/**
 * The constraints the repair agent added to get this artifact. Shown because an
 * auto-repair that silently rewrites the prompt is a black box — and because these
 * carry forward into the next re-roll, so it matters that they are visible.
 */
function AppliedFixes({ artifact }: { artifact?: Artifact }) {
  if (!artifact?.prompt_additions) return null;
  let fixes: string[] = [];
  try {
    const parsed = JSON.parse(artifact.prompt_additions);
    if (Array.isArray(parsed)) fixes = parsed as string[];
  } catch {
    return null;
  }
  if (!fixes.length) return null;

  return (
    <details className="text-xs text-ink-subtle">
      <summary className="cursor-pointer">{fixes.length} fix(es) applied by the QA agent</summary>
      {fixes.map((f, i) => (
        <p key={i} className="ml-3 mt-1 text-ink-muted">
          + {f}
        </p>
      ))}
    </details>
  );
}

function Btn({
  children,
  onClick,
  busy,
  disabled,
  small,
  variant = "primary",
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  small?: boolean;
  variant?: "primary" | "muted";
}) {
  const base = small ? "px-2.5 py-1 text-xs" : "px-4 py-2 text-sm";
  const look =
    variant === "muted" ? "bg-surface-sunken text-ink-soft border border-line-strong" : "bg-accent text-accent-ink";
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      className={`rounded-md font-medium transition-all active:scale-95 disabled:opacity-40 disabled:active:scale-100 ${base} ${look}`}
    >
      {busy ? "Working…" : children}
    </button>
  );
}
