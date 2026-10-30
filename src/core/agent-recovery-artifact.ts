import type { Task } from "./contracts";
import { culturalEvidenceId } from "./cultural-evidence";
import type { ResearchSource } from "../tools/live-research";

/**
 * Fail useful: save an explicitly INCOMPLETE snapshot of actual observations
 * when a model cannot produce the requested artifact. This is not generated
 * research, an acceptance pass, an approval, or a claimed external action.
 */
export function preservePartialAgentWork(
  task: Task,
  sources: ResearchSource[],
): string | null {
  const run = task.agentRun;

  if (!run || run.outputArtifactIds?.length) {
    return null;
  }

  const sourceEvidence = sources.flatMap((source) => {
    const id = `${task.id}:agent:${run.id}:${source.id}`;
    const record = task.evidence.find(
      (evidence) => evidence.id === id && evidence.freshness === "current",
    );

    return record
      ? [{ id, title: source.title.slice(0, 160), url: source.url }]
      : [];
  });
  const currentSeeds = new Set(run.culturalSeedIds ?? []);
  const culturalCandidates: { id: string; name: string }[] = [];

  for (const candidate of task.catalogue) {
    if (candidate.sample) {
      continue;
    }

    for (const [scope, signal] of Object.entries(candidate.cultural ?? {})) {
      if (!signal.seedIds.some((seed) => currentSeeds.has(seed))) {
        continue;
      }

      const id = culturalEvidenceId(candidate, scope, signal);
      const evidence = task.evidence.find(
        (item) =>
          item.id === id &&
          item.kind === "cultural" &&
          item.source === "provider-returned" &&
          item.freshness === "current",
      );

      if (evidence) {
        culturalCandidates.push({ id, name: candidate.name.slice(0, 120) });
      }
    }
  }
  const seenCandidates = new Set<string>();
  const uniqueCandidates = culturalCandidates.filter((candidate) => {
    if (seenCandidates.has(candidate.id)) {
      return false;
    }

    seenCandidates.add(candidate.id);
    return true;
  });

  if (sourceEvidence.length === 0 && uniqueCandidates.length === 0) {
    return null;
  }

  const safe = (value: string) => {
    return value.replace(/[\r\n<>]/g, " ").trim().slice(0, 300);
  };
  const evidenceIds = [
    ...new Set([
      ...sourceEvidence.map((source) => source.id),
      ...uniqueCandidates.map((candidate) => candidate.id),
    ]),
  ].slice(0, 30);
  const content = [
    "# Incomplete work — saved evidence",
    "",
    "## Original request",
    safe(run.goal.slice(0, 1500)),
    "",
    "## Actual observations",
    ...sourceEvidence.slice(0, 8).map(
      (source) => `- Web lead: ${safe(source.title)} — ${safe(source.url)}`,
    ),
    ...uniqueCandidates.slice(0, 12).map(
      (candidate) => `- Qloo: ${safe(candidate.name)} [${candidate.id}]`,
    ),
    "",
    "## Not yet established",
    "- Requested deliverables are NOT complete or approved.",
    "- The available leads do not confirm price, availability, feasibility, or bookings.",
    "- The agent stopped without a verified final answer. Continue from this saved evidence.",
  ].join("\n");
  const id = `agent-doc-${run.id}-recovery`;

  task.artifacts.push({
    id,
    kind: "research-report",
    title: "Incomplete evidence workpad",
    content,
    version: task.brief.version,
    dependencies: ["evidence:research"],
    evidenceIds,
    assumptions: ["Partial recovery, not a fulfilled deliverable or verified plan."],
    freshness: "current",
    edited: false,
  });
  run.warnings.push(
    "The agent saved an incomplete, source-linked workpad; requested outputs remain unverified.",
  );

  return id;
}
