"use client";

import { useCallback, useEffect, useState } from "react";
import type { Scenario } from "@/lib/pipeline/types";
import type { CriticReport } from "@/lib/agents/types";

type Artifact = { kind: string; scene_id: string | null; file_path: string; attempt: number; approved: number };
type Job = { id: string; kind: string; status: string; error: string | null; progress: string | null };
type QaRow = { stage: string; scene_id: string | null; verdict: string; report: CriticReport };

const VERDICT_STYLE: Record<string, string> = {
  PASS: "bg-green-100 text-green-800",
  REVIEW: "bg-amber-100 text-amber-800",
  FAIL: "bg-red-100 text-red-800",
  ERROR: "bg-neutral-200 text-neutral-700",
};

export default function ProjectWorkspace(props: {
  projectId: string;
  title: string;
  status: string;
  scenario: Scenario | null;
  scenarioError: string | null;
  initialBrief: string;
  initialSpendUsd: number;
  initialDiskHuman: string;
}) {
  const { projectId, scenario } = props;

  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [qa, setQa] = useState<QaRow[]>([]);
  const [spend, setSpend] = useState(props.initialSpendUsd);
  const [disk, setDisk] = useState(props.initialDiskHuman);
  const [busy, setBusy] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

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
    setDisk(detail.diskHuman ?? "0 B");
    setQa(qaRes.reports ?? []);
    setHasLoaded(true);
  }, [projectId]);

  useEffect(() => {
    void refresh();
    // Jobs run for minutes, so poll rather than making the user reload.
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  async function startJob(kind: string, sceneId?: string) {
    setBusy(sceneId ? `${kind}:${sceneId}` : kind);
    await fetch(`/api/projects/${projectId}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, sceneId }),
    });
    await refresh();
    setBusy(null);
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

  const activeJob = jobs.find((j) => j.status === "running" || j.status === "queued");
  const card = find("character_card");
  const cardApproved = card?.approved === 1;
  const approvedSheets = artifacts.filter((a) => a.kind === "storyboard" && a.approved === 1).length;

  return (
    <main className="mx-auto max-w-5xl p-8">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <a href="/" className="text-xs text-neutral-500 transition-opacity active:opacity-60 hover:underline">
            ← All projects
          </a>
          <h1 className="text-2xl font-semibold">{props.title}</h1>
        </div>
        <div className="flex gap-4 text-xs text-neutral-500">
          <span>status: {props.status}</span>
          <span>spend: ${spend.toFixed(2)}</span>
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
        <p className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{props.scenarioError}</p>
      )}
      <section className="mb-6 rounded-lg border border-neutral-200 p-4">
        <button
          onClick={() => setBriefOpen((v) => !v)}
          className="flex w-full items-center justify-between text-left text-sm font-medium transition-opacity active:opacity-60"
        >
          <span>Brief {scenario ? "(edit and re-parse)" : "— paste one to begin"}</span>
          <span className="text-xs text-neutral-400">{briefOpen ? "hide" : "show"}</span>
        </button>
        {briefOpen && (
          <div className="mt-3">
            <textarea
              value={briefText}
              onChange={(e) => setBriefText(e.target.value)}
              placeholder="Paste a creative brief — any language, any shape. An agent splits it into characters and scenes."
              rows={8}
              className="w-full rounded-md border border-neutral-300 px-3 py-2 font-mono text-xs outline-none focus:border-neutral-900"
            />
            {scenario && (
              <p className="mt-1 text-xs text-amber-700">
                Re-parsing replaces the current scenario and clears all approvals — regenerated storyboards and videos
                will need re-approving.
              </p>
            )}
            {reparseError && <p className="mt-2 rounded-md bg-red-50 p-2 text-xs text-red-700">{reparseError}</p>}
            {reparseWarnings && (
              <ul className="mt-2 space-y-0.5 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
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

      {activeJob && (
        <div className="mb-6 rounded-lg border border-neutral-300 bg-neutral-50 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {activeJob.kind} — {activeJob.status}
            </span>
            <span className="h-2 w-2 animate-pulse rounded-full bg-neutral-900" />
          </div>
          {activeJob.progress && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-neutral-600">
              {activeJob.progress}
            </pre>
          )}
        </div>
      )}

      {scenario && (
        <div className={hasLoaded ? "" : "opacity-50 transition-opacity"}>
          {/* Step 1 — character card */}
          <Step n={1} title="Character card">
            <div className="flex flex-wrap items-start gap-4">
              {card ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={fileUrl(card.file_path)} alt="Character card" className="w-72 rounded border border-neutral-200" />
              ) : (
                <div className="h-40 w-72 animate-pulse rounded bg-neutral-100" />
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
              </div>
            </div>
          </Step>

          {/* Step 2 — storyboards */}
          <Step n={2} title={`Storyboards (${approvedSheets}/${scenario.scenes.length} approved)`}>
            <Btn onClick={() => startJob("storyboards")} busy={busy === "storyboards"} disabled={!cardApproved}>
              Generate all
            </Btn>
            {!cardApproved && <span className="ml-3 text-xs text-neutral-500">Approve the character card first.</span>}

            <div className="mt-4 space-y-3">
              {scenario.scenes.map((scene) => {
                const sheet = find("storyboard", scene.id);
                const report = qaFor("storyboard", scene.id)?.report;
                return (
                  <div key={scene.id} className="flex flex-wrap items-start gap-4 rounded border border-neutral-200 p-3">
                    {sheet ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={fileUrl(sheet.file_path)} alt={`Scene ${scene.id}`} className="w-56 rounded border border-neutral-200" />
                    ) : (
                      <div className="h-24 w-56 animate-pulse rounded bg-neutral-100" />
                    )}
                    <div className="flex-1 space-y-2">
                      <p className="text-sm font-medium">
                        Scene {scene.id} — {scene.title}
                        <span className="ml-2 text-xs font-normal text-neutral-500">{scene.durationSeconds}s</span>
                        {sheet && sheet.attempt > 1 && (
                          <span className="ml-2 text-xs font-normal text-neutral-500">attempt {sheet.attempt}</span>
                        )}
                      </p>
                      <Verdict report={report} />
                      <div className="flex flex-wrap gap-2">
                        <Btn small onClick={() => startJob("storyboard_one", scene.id)} busy={busy === `storyboard_one:${scene.id}`}>
                          Re-roll
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
            <p className="mb-2 text-xs text-neutral-500">
              Only approved storyboards are rendered — this gate is what keeps paid renders downstream of the free check.
            </p>
            <Btn onClick={() => startJob("videos")} busy={busy === "videos"} disabled={approvedSheets === 0}>
              Generate approved scenes
            </Btn>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {scenario.scenes.map((scene) => {
                const clip = find("video", scene.id);
                const report = qaFor("video_scene", scene.id)?.report;
                return (
                  <div key={scene.id} className="rounded border border-neutral-200 p-3">
                    <p className="text-sm font-medium">Scene {scene.id}</p>
                    {clip ? (
                      <video src={fileUrl(clip.file_path)} controls className="mt-2 w-full rounded" />
                    ) : (
                      <div className="mt-2 aspect-[9/16] max-h-48 w-full animate-pulse rounded bg-neutral-100" />
                    )}
                    <div className="mt-2 space-y-2">
                      <Verdict report={report} />
                      <Btn small onClick={() => startJob("video_one", scene.id)} busy={busy === `video_one:${scene.id}`}>
                        Re-roll
                      </Btn>
                    </div>
                  </div>
                );
              })}
            </div>
          </Step>

          {/* Step 4 — captions + assembly */}
          <Step n={4} title="Captions & final assembly">
            <div className="flex flex-wrap gap-2">
              <Btn onClick={() => startJob("captions")} busy={busy === "captions"}>
                Build captions
              </Btn>
              <Btn onClick={() => startJob("assemble")} busy={busy === "assemble"}>
                Assemble final
              </Btn>
            </div>
            <div className="mt-3">
              <Verdict report={qaFor("assembly")?.report} />
            </div>
            {find("final") || props.status === "complete" ? (
              <video src={`/api/projects/${projectId}/file?name=FINAL.mp4`} controls className="mt-4 w-72 rounded border border-neutral-200" />
            ) : null}
          </Step>
        </div>
      )}
    </main>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8 rounded-lg border border-neutral-200 p-5">
      <h2 className="mb-3 text-sm font-medium">
        <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900 text-xs text-white">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Verdict({ report }: { report?: CriticReport }) {
  if (!report) return <p className="text-xs text-neutral-400">No QA run yet.</p>;
  const blocking = report.findings.filter((f) => f.blocking);
  const advisory = report.findings.filter((f) => !f.blocking);

  return (
    <div className="space-y-1">
      <p className="flex items-center gap-2 text-xs">
        <span className={`rounded px-1.5 py-0.5 font-medium ${VERDICT_STYLE[report.verdict] ?? ""}`}>{report.verdict}</span>
        {report.consensus && (
          <span className="text-neutral-400">
            {report.consensus.failVotes}/{report.consensus.samples} passes flagged it
          </span>
        )}
        <span className="text-neutral-600">{report.summary}</span>
      </p>
      {blocking.map((f, i) => (
        <p key={`b${i}`} className="text-xs text-red-700">
          • {f.subject ? `${f.subject}: ` : ""}
          {f.detail}
        </p>
      ))}
      {advisory.length > 0 && (
        <details className="text-xs text-neutral-500">
          <summary className="cursor-pointer">{advisory.length} advisory note(s)</summary>
          {advisory.map((f, i) => (
            <p key={`a${i}`} className="ml-3 mt-1">
              • {f.detail}
            </p>
          ))}
        </details>
      )}
    </div>
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
    variant === "muted" ? "bg-neutral-100 text-neutral-700 border border-neutral-300" : "bg-neutral-900 text-white";
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
