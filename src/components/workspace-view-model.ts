import {
  TaskSchema,
  type Task,
  type Candidate,
  type CandidateInput,
  type Evidence,
} from "@/core/contracts";

/**
 * A read-only frontend projection of the canonical Task schema actually
 * available on this UI branch. It neither copies state nor invents facts.
 */
export type WorkspaceCandidate = Candidate | CandidateInput;
export type WorkspaceEvidence = Evidence;

export type ScopedCulturalSignal = {
  key: string;
  participantId: string | null;
  participantName: string | null;
  scope: "participant" | "context" | "unknown";
  queryId: string;
  rankWithinQuery: number;
  rawAffinity: number | null;
  seedIds: readonly string[];
  explanationScope: "recommendation" | "aggregate-query" | "none" | "unknown";
  contributorIds: readonly string[];
  delivery: "LIVE" | "CACHED";
  retrievedAt: string;
};

export type GroundedMapPlace = {
  candidate: WorkspaceCandidate;
  latitude: number;
  longitude: number;
};

export type WorkspaceViewModel = {
  task: Task;
  id: string;
  revision: number;
  candidates: readonly WorkspaceCandidate[];
  mapPlaces: readonly GroundedMapPlace[];
  evidenceById: ReadonlyMap<string, Evidence>;
  candidateById: ReadonlyMap<string, WorkspaceCandidate>;
  participants: Task["brief"]["participants"];
  selectedIds: readonly string[];
  selectedCandidates: readonly WorkspaceCandidate[];
  artifacts: Task["artifacts"];
  conversation: Task["messages"];
  execution: Task["agentRun"];
  evidenceForCandidate: (id: string) => readonly Evidence[];
  culturalSignalsForCandidate: (id: string) => readonly ScopedCulturalSignal[];
};

/**
 * Use the Task currently returned by workspace-api and use-workspace.
 * The upstream WorkspaceSnapshot v1 contract is not in the base branch
 * of this frontend PR; do not introduce an unsupported endpoint.
 */
export function adaptTaskForPresentation(input: unknown): WorkspaceViewModel {
  const task = TaskSchema.parse(input);
  const byId = new Map<string, WorkspaceCandidate>();

  // Evaluated candidates override catalogue records with matching IDs.
  for (const item of task.catalogue) byId.set(item.id, item);
  for (const item of task.candidates) byId.set(item.id, item);

  const evidenceById = new Map<string, Evidence>();
  for (const item of task.evidenceArchive ?? []) evidenceById.set(item.id, item);
  for (const item of task.evidence) evidenceById.set(item.id, item);

  const participantById = new Map(
    task.brief.participants.map((person) => [person.id, person]),
  );

  const mapPlaces: GroundedMapPlace[] = [];
  for (const candidate of byId.values()) {
    if (candidate.type !== "place" || candidate.sample || !candidate.providerId) {
      continue;
    }
    const latitude = candidate.place?.latitude;
    const longitude = candidate.place?.longitude;
    if (
      latitude == null ||
      longitude == null ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      continue;
    }
    mapPlaces.push({ candidate, latitude, longitude });
  }

  function evidenceForCandidate(id: string): readonly Evidence[] {
    const candidate = byId.get(id);
    if (!candidate || !("evidenceIds" in candidate)) return [];
    return candidate.evidenceIds
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((evidence): evidence is Evidence => evidence !== undefined);
  }

  function culturalSignalsForCandidate(id: string): readonly ScopedCulturalSignal[] {
    const candidate = byId.get(id);
    if (!candidate?.cultural) return [];

    return Object.entries(candidate.cultural).map(([key, signal]) => {
      const person = participantById.get(key);
      const isParticipant = Boolean(person) && signal.signalScope !== "context";
      return {
        key,
        participantId: isParticipant && person ? person.id : null,
        participantName: isParticipant && person ? person.name : null,
        scope: isParticipant
          ? ("participant" as const)
          : signal.signalScope === "context"
            ? ("context" as const)
            : ("unknown" as const),
        queryId: signal.queryId,
        rankWithinQuery: signal.rank,
        rawAffinity: signal.affinity,
        seedIds: signal.seedIds,
        explanationScope: signal.explanationScope ?? "unknown",
        contributorIds: signal.explanationEntities.map((item) => item.entity_id),
        delivery: signal.delivery,
        retrievedAt: signal.retrievedAt,
      };
    });
  }

  return {
    task,
    id: task.id,
    revision: task.brief.version,
    candidates: [...byId.values()],
    mapPlaces,
    evidenceById,
    candidateById: byId,
    participants: task.brief.participants,
    selectedIds: task.brief.selected,
    selectedCandidates: task.brief.selected
      .map((id) => byId.get(id))
      .filter((candidate): candidate is WorkspaceCandidate => candidate !== undefined),
    artifacts: task.artifacts,
    conversation: task.messages,
    execution: task.agentRun,
    evidenceForCandidate,
    culturalSignalsForCandidate,
  };
}
