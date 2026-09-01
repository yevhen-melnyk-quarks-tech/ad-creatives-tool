"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewProjectForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [scenarioText, setScenarioText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    let scenario: unknown;
    if (scenarioText.trim()) {
      try {
        scenario = JSON.parse(scenarioText);
      } catch {
        setError("Scenario is not valid JSON.");
        setBusy(false);
        return;
      }
    }

    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, scenario }),
    });
    const data = await res.json();

    if (!res.ok) {
      // Surface schema issues rather than a generic failure — a rejected scenario is
      // almost always one wrong field, and the path tells you which.
      setError(
        data.issues
          ? `${data.error}: ${data.issues.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".")} ${i.message}`).join("; ")}`
          : (data.error ?? "Failed to create project")
      );
      setBusy(false);
      return;
    }
    router.push(`/projects/${data.id}`);
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

      <textarea
        value={scenarioText}
        onChange={(e) => setScenarioText(e.target.value)}
        placeholder="Scenario JSON (characters + scenes). Optional — you can paste it later."
        rows={8}
        className="mt-3 w-full rounded-md border border-neutral-300 px-3 py-2 font-mono text-xs outline-none focus:border-neutral-900"
      />

      {error && <p className="mt-3 rounded-md bg-red-50 p-3 text-xs text-red-700">{error}</p>}

      <button
        type="submit"
        disabled={busy || !title.trim()}
        className="mt-3 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-all active:scale-95 disabled:opacity-40 disabled:active:scale-100"
      >
        {busy ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}
