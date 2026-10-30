import { describe, expect, it } from "vitest";
import { freshTask, sampleCatalogue } from "../../src/data/fixtures";
import { culturalEvidenceId } from "../../src/core/cultural-evidence";
import { saveExperienceProposal } from "../../src/core/experience-proposal";
import { verifyAgentOutcome } from "../../src/core/agent-acceptance";
import type { Task } from "../../src/core/contracts";

function groundedTask() {
  const task = freshTask("experience-proposal", "owner");
  const candidate = {
    ...sampleCatalogue()[0],
    id: "observed-artist",
    providerId: "qloo-artist",
    sample: false,
    cultural: {
      context: {
        signalScope: "context" as const,
        affinity: null,
        rank: 1,
        queryId: "real-query",
        seedIds: ["seed-artist"],
        delivery: "LIVE" as const,
        retrievedAt: "2026-10-30T00:00:00Z",
        explanationEntities: [],
      },
    },
  };
  const evidenceId = culturalEvidenceId(
    candidate,
    "context",
    candidate.cultural.context,
  );
  task.catalogue = [candidate];
  task.evidence.push({
    id: evidenceId,
    source: "provider-returned",
    kind: "cultural",
    delivery: "LIVE",
    at: "2026-10-30T00:00:00Z",
    entityIds: ["qloo-artist"],
    reference: "qloo:real-query",
    summary: "Actual provider observation",
    limitations: [],
    explanation: null,
    dependencies: [],
    freshness: "current",
  });

  return { task, evidenceId };
}

describe("compact general-purpose experience composition", () => {
  it("creates linked decisions and editable documents using only actual evidence", () => {
    const { task, evidenceId } = groundedTask();
    const result = saveExperienceProposal(
      task,
      {
        title: "Friday community music night",
        decisions: [
          {
            domain: "music",
            value: "Listening session with a live jazz-influenced playlist",
            rationale: "The observed artist is a relevant cultural reference",
            candidateId: "observed-artist",
            estimatedCost: null,
          },
          {
            domain: "risk",
            value: "Verify capacity, insurance and practical venue terms",
            rationale: "Practical facts have not been independently checked",
          },
        ],
        documents: [
          {
            title: "Editable experience proposal",
            content:
              "Proposed listening session with audience discussion and an accessible event flow. Venue, capacity and available performers require verification.",
            fulfills: ["proposal"],
          },
          {
            title: "Partner-facing pitch",
            content:
              "A culture-led listening evening with local partners and a carefully considered soundtrack. Costs, accessibility and availability remain subject to partner verification.",
            fulfills: ["partner-pitch"],
          },
        ],
      },
      "run-proposal",
    );

    expect(result.status).not.toBe("blocked");
    expect(task.work?.decisions).toHaveLength(2);
    expect(task.work?.documents).toHaveLength(2);
    expect(task.work?.documents[0].candidateIds).toEqual(["observed-artist"]);
    expect(task.work?.documents[0].evidenceIds).toContain(evidenceId);
    expect(task.work?.documents[0].dependencies).toContain(
      "decision:agent-run-proposal-d1",
    );
    expect(result.artifactIds).toContain("document:agent-run-proposal-doc-1");
    expect(task.work?.documents[0].status).toBe("proposed");
  });

  it("accepts Qloo-backed model decisions independently of document presentation links", () => {
    const { task, evidenceId } = groundedTask();
    task.entities.push({
      id: "seed-artist",
      original: "Seed Artist",
      name: "Seed Artist",
      type: "artist",
      providerId: "seed-artist",
      status: "resolved",
      metadata: "Observed Qloo seed",
      choices: [],
    });
    task.agentRun = {
      id: "run-decision-coverage",
      goal: "Plan an evidence-linked listening evening and save a proposal",
      requirements: {
        culturalDecision: true,
        culturalReferences: ["Seed Artist"],
        experienceDomains: ["music"],
        deliverables: ["proposal"],
      },
      sources: [],
      culturalSeedIds: ["seed-artist"],
      outputArtifactIds: [],
    } as Task["agentRun"];
    const saved = saveExperienceProposal(
      task,
      {
        title: "Cultural listening evening",
        decisions: [
          {
            domain: "music",
            value: "Invite listeners to explore the Qloo-associated artist",
            rationale: "Selected from actual current Qloo observations",
            candidateId: "observed-artist",
          },
        ],
        documents: [
          {
            title: "Editable evening proposal",
            content:
              "A source-grounded listening proposal with discussion and an editable run of show. Actual prices, bookings and capacity remain unverified.",
            fulfills: ["proposal"],
          },
        ],
      },
      "run-decision-coverage",
    );
    expect(saved.status).toBe("ok");
    task.agentRun!.outputArtifactIds = saved.artifactIds;
    // A document can be a presentation of a decision without duplicating
    // candidate IDs: the model-chosen decision retains authoritative provenance.
    task.work!.documents[0].candidateIds = [];
    const result = verifyAgentOutcome(task, task.agentRun!.goal, true);
    const cultural = result.checks.find((check) =>
      check.requirement.startsWith("Current cultural decision"),
    );

    expect(task.work!.decisions[0].evidenceIds).toContain(evidenceId);
    expect(cultural?.status).toBe("satisfied");
    expect(result.status).toBe("satisfied");
  });

  it("requires model-selected evidence for each named cultural seed", () => {
    const { task } = groundedTask();
    const existingSignal = task.catalogue[0].cultural?.context;

    if (!existingSignal) {
      throw new Error("Expected a seeded cultural fixture");
    }

    const second = {
      ...task.catalogue[0],
      id: "observed-second-artist",
      providerId: "qloo-second",
      cultural: {
        context: {
          ...existingSignal,
          queryId: "second-real-query",
          seedIds: ["seed-2"],
        },
      },
    };
    task.catalogue.push(second);
    task.evidence.push({
      ...task.evidence[0],
      id: culturalEvidenceId(second, "context", second.cultural.context),
      reference: "qloo:second-real-query",
    });
    task.entities.push({
      id: "second-seed",
      original: "Second Artist",
      name: "Second Artist",
      type: "artist",
      providerId: "seed-2",
      status: "resolved",
      metadata: "Unit-test Qloo seed",
      choices: [],
    });
    task.agentRun = {
      requirements: {
        culturalDecision: true,
        culturalReferences: ["Second Artist"],
        deliverables: ["proposal"],
      },
    } as Task["agentRun"];

    const result = saveExperienceProposal(
      task,
      {
        title: "Evidence-grounded cultural evening",
        decisions: [
          {
            domain: "music",
            value: "Use the first observed artist",
            rationale: "The first candidate was actually retrieved",
            candidateId: "observed-artist",
          },
        ],
        documents: [
          {
            title: "Draft",
            content:
              "An incomplete cultural proposal that must not claim to cover both separate seed references without evidence.",
            fulfills: ["proposal"],
          },
        ],
      },
      "run-missing-seed",
    );

    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("observed-second-artist");
    expect(task.work?.documents ?? []).toEqual([]);
    expect(task.work?.decisions ?? []).toEqual([]);
  });

  it("blocks invented cultural selections without changing saved work", () => {
    const { task } = groundedTask();
    const result = saveExperienceProposal(
      task,
      {
        title: "Unsupported event",
        decisions: [
          {
            domain: "music",
            value: "Unknown music recommendation",
            rationale: "Invented candidate cannot be sourced",
            candidateId: "not-observed",
          },
        ],
        documents: [
          {
            title: "Unverified proposal",
            content:
              "This proposal must never be saved because its supposed cultural reference was invented rather than observed from the configured provider.",
            fulfills: ["proposal"],
          },
        ],
      },
      "run-blocked",
    );

    expect(result.status).toBe("blocked");
    expect(task.work?.decisions ?? []).toEqual([]);
    expect(task.work?.documents ?? []).toEqual([]);
  });
});
