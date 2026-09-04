import { notFound } from "next/navigation";
import { db, projectSpendUsd } from "@/lib/db";
import { projectDir, dirSizeBytes, humanBytes } from "@/lib/paths";
import { ScenarioSchema } from "@/lib/pipeline/types";
import ProjectWorkspace from "./ProjectWorkspace";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export default async function ProjectPage({ params }: Ctx) {
  const { id } = await params;
  const project = db().prepare(`SELECT * FROM projects WHERE id=?`).get(id) as
    | { id: string; title: string; status: string; scenario_json: string | null; brief: string | null; video_resolution: string | null }
    | undefined;
  if (!project) notFound();

  const parsed = project.scenario_json ? ScenarioSchema.safeParse(JSON.parse(project.scenario_json)) : null;
  const bytes = await dirSizeBytes(projectDir(id));

  return (
    <ProjectWorkspace
      projectId={id}
      title={project.title}
      status={project.status}
      scenario={parsed?.success ? parsed.data : null}
      scenarioError={parsed && !parsed.success ? "Stored scenario no longer matches the schema." : null}
      initialBrief={project.brief ?? ""}
      initialResolution={project.video_resolution === "720p" ? "720p" : "480p"}
      initialSpendUsd={projectSpendUsd(id)}
      initialDiskHuman={humanBytes(bytes)}
    />
  );
}
