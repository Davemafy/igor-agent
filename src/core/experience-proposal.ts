import { z } from "zod";
import { culturalEvidenceId } from "./cultural-evidence";
import { applyWorkActions } from "./connected-work";
import { critiqueExperience } from "./experience-critique";
import type { Task } from "./contracts";
import type { WorkAction } from "./work-contracts";

/**
 * A compact, model-directed authoring contract. The model chooses values,
 * decisions, and deliverable content; the server owns stable work IDs,
 * dependencies, and exact Qloo evidence binding. No external actions, model
 * approvals, fake sources, or synthetic cultural recommendations.
 */
export const ExperienceProposalArguments = z.strictObject({
  title: z.string().trim().min(3).max(160),
  decisions: z
    .array(
      z.strictObject({
        domain: z.enum([
          "audience",
          "culture",
          "music",
          "food",
          "atmosphere",
          "venue",
          "identity",
          "schedule",
          "budget",
          "constraints",
          "risk",
        ]),
        value: z.string().trim().min(4).max(1500),
        rationale: z.string().trim().min(4).max(1000),
        candidateId: z.string().optional(),
        estimatedCost: z.number().nonnegative().nullable().optional(),
      }),
    )
    .min(1)
    .max(12),
  documents: z
    .array(
      z.strictObject({
        title: z.string().trim().min(3).max(160),
        content: z.string().trim().min(50).max(8500),
        fulfills: z.array(z.string().max(80)).min(1).max(6),
      }),
    )
    .min(1)
    .max(4),
});

export function saveExperienceProposal(
  task: Task,
  input: z.infer<typeof ExperienceProposalArguments>,
  runId: string,
): { status: "ok" | "partial" | "blocked"; summary: string; artifactIds: string[] } {
  const parsed = ExperienceProposalArguments.parse(input);
  const evidenceForCandidate = (id: string) => {
    const candidate = task.catalogue.find((item) => item.id === id && !item.sample);

    if (!candidate) {
      return null;
    }

    const evidence = Object.entries(candidate.cultural ?? {})
      .map(([scope, signal]) => culturalEvidenceId(candidate, scope, signal))
      .filter((id) =>
        task.evidence.some(
          (item) =>
            item.id === id &&
            item.kind === "cultural" &&
            item.source === "provider-returned" &&
            item.freshness === "current",
        ),
      );

    return evidence.length ? evidence : null;
  };

  const cited = parsed.decisions.flatMap((decision) =>
    decision.candidateId ? [decision.candidateId] : [],
  );
  const evidenceByCandidate = new Map<string, string[]>();

  for (const candidateId of cited) {
    const evidence = evidenceForCandidate(candidateId);

    if (!evidence) {
      return {
        status: "blocked",
        summary: "Proposal references a cultural candidate without current Qloo evidence.",
        artifactIds: [],
      };
    }

    evidenceByCandidate.set(candidateId, evidence);
  }

  const previousGoal = task.work?.activeGoalId;
  const goalId = previousGoal ?? `agent-${runId}-goal`;
  const actions: WorkAction[] = previousGoal
    ? []
    : [{ kind: "goal", id: goalId, title: parsed.title }];
  const allEvidence = [...new Set([...evidenceByCandidate.values()].flat())];
  const allCandidates = [...new Set(cited)];
  const decisionIds: string[] = [];

  for (const [index, decision] of parsed.decisions.entries()) {
    const id = `agent-${runId}-d${index + 1}`;
    decisionIds.push(id);
    const evidenceIds = decision.candidateId
      ? (evidenceByCandidate.get(decision.candidateId) ?? [])
      : [];

    actions.push({
      kind: "decision",
      id,
      title: `${decision.domain}: ${decision.value.slice(0, 80)}`,
      domain: decision.domain,
      value: decision.value,
      rationale: decision.rationale,
      rationaleKind: evidenceIds.length ? "cultural-evidence" : "interpretation",
      candidateIds: decision.candidateId ? [decision.candidateId] : [],
      evidenceIds,
      dependencies: [],
      estimatedCost: decision.estimatedCost ?? null,
    });
  }

  const artifactIds: string[] = [];

  for (const [index, document] of parsed.documents.entries()) {
    const id = `agent-${runId}-doc-${index + 1}`;
    actions.push({
      kind: "document",
      id,
      title: document.title,
      content: `${document.content}\n\nPractical prices, bookings, locations, and availability require independent verification.`,
      candidateIds: allCandidates,
      evidenceIds: allEvidence,
      fulfills: document.fulfills,
      dependencies: decisionIds.map((item) => `decision:${item}`),
    });
    artifactIds.push(`document:${id}`);
  }

  const userText =
    task.messages.filter((message) => message.role === "user").at(-1)?.text ??
    task.agentRun?.goal ??
    "";
  const summary = applyWorkActions(task, actions, userText);
  task.work!.critique = critiqueExperience(task);

  return {
    status: task.work!.critique.issues.some((issue) => issue.severity === "error")
      ? "partial"
      : "ok",
    summary: `Saved proposed connected work: ${summary.slice(0, 360)}. All referenced cultural IDs were verified against this task.`,
    artifactIds,
  };
}
