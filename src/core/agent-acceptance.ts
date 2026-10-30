import { culturalEvidenceId } from "./cultural-evidence";
import { z } from "zod";
import { critiqueExperience } from "./experience-critique";
import type { Task } from "./contracts";

/** Model interpretation of the current turn in its conversational context.
 * Missing interpretation is unknown, never inferred from provider keywords. */
export const AgentRequirementsSchema = z
  .object({
    location: z
      .object({
        value: z.string().trim().min(1).max(100),
        sourceText: z.string().trim().min(1).max(1000),
      })
      .nullable()
      .optional(),
    budget: z
      .object({
        amount: z.number().min(0).max(1000000),
        sourceText: z.string().trim().min(1).max(1000),
      })
      .nullable()
      .optional(),
    experienceDomains: z
      .array(
        z.enum([
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
      )
      .max(12)
      .optional(),
    culturalDecision: z.boolean(),
    culturalReferences: z.array(z.string().trim().min(1).max(120)).max(12),
    deliverables: z.array(z.string().trim().min(1).max(80)).max(6),
  })
  .refine(
    (value) => value.culturalDecision || value.culturalReferences.length === 0,
    "Named cultural obligations require cultural grounding",
  );
export type AgentRequirements = z.infer<typeof AgentRequirementsSchema>;
export const AgentAcceptanceSchema = z.object({
  requestedOutcome: z.string(),
  status: z.enum(["satisfied", "unknown", "blocked"]),
  checks: z.array(
    z.object({
      requirement: z.string(),
      status: z.enum(["satisfied", "unknown", "blocked"]),
      artifactIds: z.array(z.string()),
      evidenceIds: z.array(z.string()),
    }),
  ),
});

export { culturalEvidenceId } from "./cultural-evidence";

/** A read projection, not a second stored copy of a connected document. */
export function agentSavedDocuments(task: Task) {
  const run = task.agentRun;

  if (!run) {
    return [];
  }

  return [
    ...task.artifacts.filter(
      (a) =>
        (a.id.startsWith(`agent-doc-${run.id}-`) ||
          run.outputArtifactIds?.includes(a.id)) &&
        a.freshness === "current",
    ),
    ...(task.work?.documents ?? [])
      .filter(
        (d) =>
          run.outputArtifactIds?.includes(`document:${d.id}`) &&
          d.freshness === "current",
      )
      .map((d) => ({ ...d, id: `document:${d.id}` })),
  ];
}

export function verifyAgentOutcome(
  task: Task,
  goal: string,
  modelFinished: boolean,
) {
  const run = task.agentRun!;
  const requirements = run.requirements;
  const documents = agentSavedDocuments(task);
  const checks: z.infer<typeof AgentAcceptanceSchema>["checks"] = [];
  const check = (
    requirement: string,
    satisfied: boolean,
    artifactIds: string[] = [],
    evidenceIds: string[] = [],
  ) =>
    checks.push({
      requirement,
      status: satisfied ? "satisfied" : "unknown",
      artifactIds,
      evidenceIds,
    });
  check(
    "Current turn requirements have been interpreted",
    Boolean(requirements),
  );

  if (requirements?.location) {
    check(
      "Interpreted location is retained",
      task.brief.constraints.location === requirements.location.value,
    );
  }

  if (requirements?.budget) {
    check(
      "Interpreted budget is confirmed and retained",
      task.brief.constraints.budget === requirements.budget.amount &&
        task.work?.budget?.amount === requirements.budget.amount &&
        task.work.budget.confirmed,
    );
  }

  // Source-dependent public research cannot be certified by a fluent
  // document or a Qloo-only observation. Evidence must have been retrieved in
  // THIS run, persisted, and cited by any new agent-authored document.
  const needsPublicResearch =
    !requirements?.culturalDecision &&
    /\b(?:research|investigate|fact[ -]?check|source[ -]?backed|verify|market analysis)\b/i.test(
      goal,
    );

  if (needsPublicResearch) {
    const sourceEvidenceIds = run.sources
      .map((source) => `${task.id}:agent:${run.id}:${source.id}`)
      .filter((id) =>
        task.evidence.some(
          (evidence) =>
            evidence.id === id &&
            evidence.kind === "practical" &&
            evidence.source === "provider-returned" &&
            evidence.freshness === "current",
        ),
      );
    const citedByDeliverable =
      documents.length === 0 ||
      documents.some((document) =>
        document.evidenceIds.some((id) => sourceEvidenceIds.includes(id)),
      );

    check(
      "Public research is grounded in retrieved, saved source evidence",
      sourceEvidenceIds.length > 0 && citedByDeliverable,
      documents.map((document) => document.id),
      sourceEvidenceIds,
    );
  }

  for (const key of requirements?.deliverables ?? []) {
    const matching = documents.filter((a) => a.fulfills?.includes(key));
    check(
      `Saved editable deliverable: ${key}`,
      matching.length > 0,
      matching.map((a) => a.id),
      matching.flatMap((a) => a.evidenceIds),
    );
  }

  // Experience-domain slots are meaningful only for an actual experience
  // workspace. A research memo may discuss risk and budget without requiring
  // synthetic venue/schedule/experience decisions to count as complete.
  const connectedExperience =
    Boolean(requirements?.culturalDecision) ||
    Boolean(task.work?.activeGoalId);

  for (const domain of connectedExperience
    ? (requirements?.experienceDomains ?? [])
    : []) {
    const matching =
      task.work?.decisions.filter(
        (d) =>
          d.goalId === task.work?.activeGoalId &&
          d.domain === domain &&
          d.status !== "rejected" &&
          d.freshness !== "stale",
      ) ?? [];
    check(
      `Linked experience decision: ${domain}`,
      matching.length > 0,
      documents.map((d) => d.id),
      matching.flatMap((d) => d.evidenceIds),
    );
  }

  if (task.work?.decisions.some((d) => d.domain && d.domain !== "general")) {
    check(
      "Experience has no unresolved hard contradictions",
      !critiqueExperience(task).issues.some(
        (issue) => issue.severity === "error",
      ),
      documents.map((d) => d.id),
    );
  }

  if (requirements?.culturalDecision || run.culturalSeedIds?.length) {
    // A cultural decision must bind a selected candidate to current provider
    // evidence AND to all current reference seeds. An old unrelated record,
    // entity lookup, or a Radiohead query after a Bad Bunny revision cannot pass.
    const referenceNames = requirements?.culturalReferences.length
      ? requirements.culturalReferences
      : (run.culturalSeedIds ?? []).map(
          (id) =>
            task.entities.find((e) => e.providerId === id)?.name ??
            "Unresolved cultural seed",
        );
    const refs = referenceNames.map(
      (name) =>
        task.entities.find(
          (e) =>
            e.status === "resolved" &&
            e.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
        )?.providerId,
    );
    const seedIds = new Set(refs.filter((id): id is string => Boolean(id)));
    const supporting = new Set<string>();
    const covered = new Set<string>();
    const bindings = documents.filter((a) => a.candidateIds?.length);

    for (const doc of bindings) {
      for (const id of doc.candidateIds ?? []) {
        const candidate = task.catalogue.find((c) => c.id === id && !c.sample);

        if (
          !candidate ||
          task.candidates.some((c) => c.id === id && c.freshness !== "current")
        ) {
          continue;
        }

        for (const [scope, signal] of Object.entries(
          candidate.cultural ?? {},
        )) {
          const evidenceId = culturalEvidenceId(candidate, scope, signal);
          const evidence = task.evidence.find(
            (e) =>
              e.id === evidenceId &&
              e.source === "provider-returned" &&
              e.kind === "cultural" &&
              e.freshness === "current" &&
              e.delivery === signal.delivery &&
              e.entityIds.includes(candidate.providerId ?? candidate.id),
          );

          if (
            !evidence ||
            !doc.evidenceIds.includes(evidenceId) ||
            !signal.seedIds.some((seed) => seedIds.has(seed))
          ) {
            continue;
          }

          supporting.add(evidenceId);
          signal.seedIds
            .filter((seed) => seedIds.has(seed))
            .forEach((seed) => covered.add(seed));
        }
      }
    }

    check(
      "Current cultural decision is grounded in cited candidate/query evidence for every current reference",
      refs.length > 0 && refs.every((id) => Boolean(id) && covered.has(id!)),
      bindings.map((a) => a.id),
      [...supporting],
    );
  }

  check(
    "Agent reviewed observations or saved work before ending",
    (modelFinished || documents.length > 0) &&
      (documents.length > 0 || run.sources.length > 0),
  );

  return AgentAcceptanceSchema.parse({
    requestedOutcome: goal.slice(0, 3000),
    status: checks.every((c) => c.status === "satisfied")
      ? "satisfied"
      : "unknown",
    checks,
  });
}
