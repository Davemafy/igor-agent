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
): {
  status: "ok" | "partial" | "blocked";
  summary: string;
  artifactIds: string[];
} {
  const parsed = ExperienceProposalArguments.parse(input);
  const budget = task.agentRun?.requirements?.budget;
  const latestRequest =
    task.messages.filter((message) => message.role === "user").at(-1)?.text ??
    task.agentRun?.goal ??
    "";
  const estimatedTotal = parsed.decisions.reduce(
    (sum, decision) => sum + (decision.estimatedCost ?? 0),
    0,
  );

  // An explicit user ceiling is an execution constraint, not a suggestion.
  // Reject an infeasible model-authored allocation before mutating saved work.
  // Unknown prices remain null and must never be represented as zero quotes.
  if (
    budget &&
    latestRequest.includes(budget.sourceText) &&
    estimatedTotal > budget.amount
  ) {
    const overage = Math.round((estimatedTotal - budget.amount) * 100) / 100;

    return {
      status: "blocked",
      summary:
        `Proposed estimates total ${estimatedTotal}, exceeding the user budget ${budget.amount} by ${overage}. Submit a corrected experience.propose with a total at or below the ceiling. Unknown vendor costs must remain null, not fabricated or called free. No work saved.`,
      artifactIds: [],
    };
  }

  const evidenceForCandidate = (id: string) => {
    const candidate = task.catalogue.find(
      (item) => item.id === id && !item.sample,
    );

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

  // A multi-reference cultural request is incomplete unless every named
  // Qloo seed informs at least one model-chosen, evidence-backed decision.
  // Do not manufacture decisions or weaken acceptance; instead return the
  // exact eligible candidate IDs so the model can repair its proposal.
  const requiredReferences = task.agentRun?.requirements?.culturalDecision
    ? (task.agentRun.requirements.culturalReferences ?? [])
    : [];
  const missingReferences: string[] = [];

  for (const name of requiredReferences) {
    const seed = task.entities.find(
      (entity) =>
        entity.status === "resolved" &&
        entity.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    const seedId = seed?.providerId;
    const eligible: string[] = [];

    if (seedId) {
      for (const candidate of task.catalogue) {
        if (candidate.sample) {
          continue;
        }

        for (const [scope, signal] of Object.entries(
          candidate.cultural ?? {},
        )) {
          if (!signal.seedIds.includes(seedId)) {
            continue;
          }

          const id = culturalEvidenceId(candidate, scope, signal);
          const grounded = task.evidence.some(
            (evidence) =>
              evidence.id === id &&
              evidence.kind === "cultural" &&
              evidence.source === "provider-returned" &&
              evidence.freshness === "current",
          );

          if (grounded) {
            eligible.push(candidate.id);
            break;
          }
        }
      }
    }

    const covered = parsed.decisions.some((decision) =>
      eligible.includes(decision.candidateId ?? ""),
    );

    if (!covered) {
      missingReferences.push(
        `${name}: ${eligible.slice(0, 4).join(", ") || "no observed candidates"}`,
      );
    }
  }

  if (missingReferences.length) {
    return {
      status: "blocked",
      summary: `Connect at least one Qloo-backed decision to each missing user taste reference using these observed candidate IDs: ${missingReferences.join("; ").slice(0, 700)}. No work was saved.`,
      artifactIds: [],
    };
  }

  const cited = parsed.decisions.flatMap((decision) =>
    decision.candidateId ? [decision.candidateId] : [],
  );
  const evidenceByCandidate = new Map<string, string[]>();

  for (const candidateId of cited) {
    const evidence = evidenceForCandidate(candidateId);

    if (!evidence) {
      return {
        status: "blocked",
        summary:
          "Proposal references a cultural candidate without current Qloo evidence.",
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
  if (
    budget &&
    latestRequest.includes(budget.sourceText) &&
    task.work?.budget?.amount !== budget.amount
  ) {
    actions.push({ kind: "budget", amount: budget.amount });
  }

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
      rationaleKind: evidenceIds.length
        ? "cultural-evidence"
        : "interpretation",
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

  const summary = applyWorkActions(task, actions, latestRequest);
  task.work!.critique = critiqueExperience(task);

  return {
    status: task.work!.critique.issues.some(
      (issue) => issue.severity === "error",
    )
      ? "partial"
      : "ok",
    summary: `Saved proposed connected work: ${summary.slice(0, 360)}. All referenced cultural IDs were verified against this task.`,
    artifactIds,
  };
}
