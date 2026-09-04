import Link from "next/link";
import { db } from "@/lib/db";
import { ensureWorker } from "@/lib/jobs/worker";
import NewProjectForm from "./NewProjectForm";
import ThemeToggle from "./ThemeToggle";

export const dynamic = "force-dynamic";

type Row = { id: string; title: string; status: string; created_at: string };

export default function Home() {
  // Kick the job loop on first page load, so a restarted container picks up work
  // without waiting for someone to hit an API route.
  ensureWorker();
  const projects = db()
    .prepare(`SELECT id, title, status, created_at FROM projects ORDER BY created_at DESC`)
    .all() as Row[];

  return (
    <main className="mx-auto max-w-4xl p-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Ad Creatives Tool</h1>
          <p className="mt-1 text-sm text-ink-subtle">
            Scenario → character card → storyboards → video, with an AI QA gate at every step.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <NewProjectForm />

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-ink-subtle">Projects</h2>
        {projects.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-strong p-6 text-sm text-ink-subtle">
            No projects yet.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-lg border border-line">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.id}`}
                  className="flex items-center justify-between p-4 transition-all active:scale-[0.99] hover:bg-surface-muted"
                >
                  <span>
                    <span className="font-medium">{p.title}</span>
                    <span className="ml-3 text-xs text-ink-subtle">{p.created_at}</span>
                  </span>
                  <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">{p.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
