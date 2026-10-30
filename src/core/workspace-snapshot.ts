import { z } from "zod";
import {
  AgentRunHistorySchema,
  AgentRunSchema,
  ArtifactSchema,
  CandidateInputSchema,
  ConversationFocusSchema,
  EvidenceSchema,
  TaskSchema,
  type Task,
} from "./contracts";
import { WorkStateSchema } from "./work-contracts";

/**
 * Additive, read-only API contract for an independently developed Igor client.
 * This is a projection of the authoritative Task, not a second state model.
 * Actions, turn admission and durable event replay retain their existing APIs.
 */
export const WorkspaceSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  id: TaskSchema.shape.id,
  revision: TaskSchema.shape.brief.shape.version,
  goal: TaskSchema.shape.brief.shape.goal,
  status: TaskSchema.shape.status,
  mode: TaskSchema.shape.mode,
  conversation: z.object({
    messages: TaskSchema.shape.messages,
    focus: ConversationFocusSchema.nullable(),
  }),
  participants: TaskSchema.shape.brief.shape.participants,
  discovery: z.object({
    catalogue: TaskSchema.shape.catalogue,
    candidates: TaskSchema.shape.candidates,
    entities: TaskSchema.shape.entities,
    evidence: TaskSchema.shape.evidence,
    evidenceArchive: z.array(EvidenceSchema),
  }),
  spatial: z.object({
    // All place candidates are visible, including those without coordinates.
    places: z.array(CandidateInputSchema),
    // Only non-sample candidates with both coordinates can produce map pins.
    geocodedPlaceIds: z.array(z.string()),
  }),
  plan: z.object({
    selectedCandidateIds: TaskSchema.shape.brief.shape.selected,
    schedule: TaskSchema.shape.schedule,
    work: WorkStateSchema.nullable(),
  }),
  artifacts: z.object({
    current: TaskSchema.shape.artifacts,
    history: z.array(
      z.object({
        artifact: ArtifactSchema,
        at: z.string(),
        reason: z.string(),
      }),
    ),
  }),
  execution: z.object({
    current: AgentRunSchema.nullable(),
    history: z.array(AgentRunHistorySchema),
    trace: TaskSchema.shape.trace,
    error: TaskSchema.shape.error,
  }),
});

export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

/** Preserve IDs, provenance, edits, and revisions verbatim. Never invent scores,
 * availability, images, map coordinates or successful external operations.
 */
export function projectWorkspace(task: Task): WorkspaceSnapshot {
  // Qloo and practical discovery can return places before candidate evaluation.
  // Prefer the evaluated version when both collections contain the same ID.
  const places = [
    ...task.candidates.filter((candidate) => candidate.type === "place"),
    ...task.catalogue.filter((candidate) => candidate.type === "place"),
  ].filter((place, index, all) => all.findIndex((item) => item.id === place.id) === index);
  const geocodedPlaceIds = places
    .filter(
      (candidate) =>
        !candidate.sample &&
        candidate.place?.latitude != null &&
        candidate.place?.longitude != null,
    )
    .map((candidate) => candidate.id);

  return WorkspaceSnapshotSchema.parse({
    schemaVersion: 1,
    id: task.id,
    revision: task.brief.version,
    goal: task.brief.goal,
    status: task.status,
    mode: task.mode,
    conversation: {
      messages: task.messages,
      focus: task.conversationFocus ?? null,
    },
    participants: task.brief.participants,
    discovery: {
      catalogue: task.catalogue,
      candidates: task.candidates,
      entities: task.entities,
      evidence: task.evidence,
      evidenceArchive: task.evidenceArchive ?? [],
    },
    spatial: { places, geocodedPlaceIds },
    plan: {
      selectedCandidateIds: task.brief.selected,
      schedule: task.schedule,
      work: task.work ?? null,
    },
    artifacts: {
      current: task.artifacts,
      history: task.artifactHistory ?? [],
    },
    execution: {
      current: task.agentRun ?? null,
      history: task.agentRunHistory ?? [],
      trace: task.trace,
      error: task.error,
    },
  });
}
