"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const BRIEF_PLACEHOLDER = `Paste a creative brief here — copy straight out of Notion, any language, any shape. For example:

ПЕРСОНАЖІ

Джон Картер, тато
40 р. простий одяг. Люблячий, трохи безтурботний...

СЦЕНАРІЙ

Сцена 1, вдома, ранок.
Кухня, родина снідає...
[Мія] Dad, are we really going on vacation this summer?
[Джон] I know. This time, for real.

An agent will split this into characters and scenes automatically — no particular format required.`;

export default function NewProjectForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"brief" | "json">("brief");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    // Reading client-side rather than a server upload endpoint: a Notion export
    // (.txt/.csv/.md) is plain text, and the parser only ever needs the text content,
    // never the original file.
    setText(await file.text());
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setWarnings(null);

    const body: { title: string; brief?: string; scenario?: unknown } = { title };
    if (mode === "json") {
      try {
        body.scenario = JSON.parse(text);
      } catch {
        setError("Scenario is not valid JSON.");
        setBusy(false);
        return;
      }
    } else if (text.trim()) {
      body.brief = text;
    }

    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok) {
      setError(
        data.issues
          ? `${data.error}: ${data.issues.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".")} ${i.message}`).join("; ")}`
          : (data.error ?? "Failed to create project")
      );
      setBusy(false);
      return;
    }

    setBusy(false);
    if (data.warnings?.length) {
      // A generative parse can misfire quietly (an unresolved speaker name, a scene
      // with no recognised cast) — show what the agent flagged before handing off to
      // the review screen, rather than silently continuing on a shaky scenario.
      setWarnings(data.warnings);
      setPendingId(data.id);
    } else {
      router.push(`/projects/${data.id}`);
    }
  }

  if (warnings && pendingId) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-5">
        <h2 className="mb-2 text-sm font-medium text-amber-900">Parsed with {warnings.length} note(s)</h2>
        <ul className="mb-4 space-y-1 text-xs text-amber-800">
          {warnings.map((w, i) => (
            <li key={i}>• {w}</li>
          ))}
        </ul>
        <p className="mb-3 text-xs text-amber-700">
          The scenario was still created — review characters and scenes on the project page.
        </p>
        <button
          onClick={() => router.push(`/projects/${pendingId}`)}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-all active:scale-95"
        >
          Open project →
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-neutral-200 p-5">
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-500">New project</h2>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Project title"
        required
        className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
      />

      <div className="mt-3 flex items-center justify-between">
        <div className="flex gap-1 rounded-md bg-neutral-100 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setMode("brief")}
            className={`rounded px-2.5 py-1 font-medium transition-all active:scale-95 ${mode === "brief" ? "bg-white shadow-sm" : "text-neutral-500"}`}
          >
            Paste brief
          </button>
          <button
            type="button"
            onClick={() => setMode("json")}
            className={`rounded px-2.5 py-1 font-medium transition-all active:scale-95 ${mode === "json" ? "bg-white shadow-sm" : "text-neutral-500"}`}
          >
            Paste scenario JSON
          </button>
        </div>
        {mode === "brief" && (
          <>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="text-xs text-neutral-500 underline transition-opacity active:opacity-60"
            >
              or upload a file
            </button>
            <input ref={fileInput} type="file" accept=".txt,.md,.csv" onChange={onFilePicked} className="hidden" />
          </>
        )}
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={mode === "brief" ? BRIEF_PLACEHOLDER : "Scenario JSON (optional — you can paste it later)"}
        rows={mode === "brief" ? 10 : 8}
        className="mt-2 w-full rounded-md border border-neutral-300 px-3 py-2 text-xs font-mono outline-none focus:border-neutral-900"
      />
      {mode === "brief" && (
        <p className="mt-1 text-xs text-neutral-500">
          An agent will split this into characters and scenes — leave it empty to author the scenario later.
        </p>
      )}

      {error && <p className="mt-3 rounded-md bg-red-50 p-3 text-xs text-red-700">{error}</p>}

      <button
        type="submit"
        disabled={busy || !title.trim()}
        className="mt-3 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-all active:scale-95 disabled:opacity-40 disabled:active:scale-100"
      >
        {busy ? (mode === "brief" && text.trim() ? "Parsing brief…" : "Creating…") : "Create project"}
      </button>
    </form>
  );
}
