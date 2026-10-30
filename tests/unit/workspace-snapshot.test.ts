import { describe, expect, it } from "vitest";
import { CandidateSchema } from "../../src/core/contracts";
import {
  projectWorkspace,
  WorkspaceSnapshotSchema,
} from "../../src/core/workspace-snapshot";
import { emptyWork } from "../../src/core/work-contracts";
import { fixtureDate, freshTask } from "../../src/data/fixtures";

const makePlace = (id: string, sample: boolean, latitude: number | null) => {
  const task = freshTask("fixture", "owner");
  return CandidateSchema.parse({
    ...task.catalogue[0],
    id,
    name: id,
    type: "place",
    providerId: sample ? "fixture:place" : "places:verified",
    sample,
    available: null,
    availabilitySource: sample ? "illustrative-example" : "provider-returned",
    place: {
      latitude,
      longitude: -73.99,
      address: sample ? "Illustrative address" : "Verified source address",
      website: null,
      locality: null,
    },
    eligibility: "needs-review",
    dependencies: [],
    missing: ["availability"],
    violations: [],
    evidenceIds: [],
    fit: {},
    fitReason: "Unverified availability.",
  });
};

describe("versioned workspace snapshot integration contract", () => {
  it("reads the existing task without establishing a parallel state store", () => {
    const task = freshTask("task-1", "owner");
    task.brief.goal = "Investigate the EV charging market";
    task.brief.version = 4;
    task.messages.push({
      id: "message-1",
      role: "user",
      text: "Investigate the EV charging market",
      at: fixtureDate,
    });
    task.work = emptyWork();
    task.artifacts.push({
      id: "report-1",
      kind: "research-report",
      title: "EV charging market",
      content: "Working research memo",
      version: 2,
      dependencies: [],
      evidenceIds: [],
      assumptions: [],
      freshness: "current",
      edited: true,
    });

    const snapshot = projectWorkspace(task);
    expect(WorkspaceSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.revision).toBe(4);
    expect(snapshot.conversation.messages[0].id).toBe("message-1");
    expect(snapshot.artifacts.current[0].version).toBe(2);
    expect(snapshot.artifacts.current[0].edited).toBe(true);
    expect(snapshot.plan.work).toEqual(task.work);

    task.artifacts[0].content = "Later edit";
    expect(snapshot.artifacts.current[0].content).toBe("Working research memo");
    expect(WorkspaceSnapshotSchema.safeParse({
      ...snapshot,
      schemaVersion: 2,
    }).success).toBe(false);
  });

  it("includes only real, complete coordinates in map pin eligibility", () => {
    const task = freshTask("task-2", "owner");
    task.candidates = [
      makePlace("real-place", false, 40.73),
      makePlace("sample-place", true, 40.71),
      makePlace("no-latitude", false, null),
    ];

    const snapshot = projectWorkspace(task);
    expect(snapshot.spatial.places.map((candidate) => candidate.id)).toEqual([
      "real-place",
      "sample-place",
      "no-latitude",
    ]);
    expect(snapshot.spatial.geocodedPlaceIds).toEqual(["real-place"]);
    expect(snapshot.spatial.places[2].place?.latitude).toBeNull();
  });

  it("displays unevaluated Qloo catalogue places without inventing fit or availability", () => {
    const task = freshTask("task-map", "owner");
    const place = makePlace("newly-discovered", false, 40.70);
    task.candidates = [];
    task.catalogue = [{
      id: place.id,
      providerId: place.providerId,
      name: place.name,
      type: "place",
      tags: [],
      description: "Provider-discovered place",
      cost: place.cost,
      duration: place.duration,
      available: null,
      availabilitySource: "provider-returned",
      location: "New York",
      sample: false,
      place: place.place,
    }];

    const snapshot = projectWorkspace(task);
    expect(snapshot.discovery.catalogue).toHaveLength(1);
    expect(snapshot.discovery.candidates).toHaveLength(0);
    expect(snapshot.spatial.places.map((result) => result.id)).toEqual([
      "newly-discovered",
    ]);
    expect(snapshot.spatial.geocodedPlaceIds).toEqual(["newly-discovered"]);
    expect(snapshot.spatial.places[0].available).toBeNull();
  });

  it("does not claim evidence, affinity, availability, or external-action success", () => {
    const task = freshTask("task-3", "owner");
    task.status = "partial";
    task.error = "Model provider unavailable";
    task.work = emptyWork();
    task.work.externalActions.push({
      id: "outbound-1",
      connector: "agentmail",
      action: "send message",
      status: "blocked",
      reason: "Approval and provider integration are not configured",
      at: fixtureDate,
    });

    const snapshot = projectWorkspace(task);
    expect(snapshot.status).toBe("partial");
    expect(snapshot.execution.error).toBe("Model provider unavailable");
    expect(snapshot.discovery.evidence).toEqual([]);
    expect(snapshot.discovery.candidates).toEqual([]);
    expect(snapshot.plan.work?.externalActions[0].status).toBe("blocked");
    expect(snapshot.spatial.geocodedPlaceIds).toEqual([]);
  });

  it("preserves source and evidence IDs from the authoritative task", () => {
    const task = freshTask("task-4", "owner");
    task.evidence.push({
      id: "source-1",
      source: "verified-external",
      at: fixtureDate,
      reference: "https://example.org/research",
      entityIds: [],
      summary: "Observed source text",
      limitations: ["Pricing not established"],
      explanation: null,
      dependencies: [],
      freshness: "current",
    });
    const snapshot = projectWorkspace(task);
    expect(snapshot.discovery.evidence[0].id).toBe("source-1");
    expect(snapshot.discovery.evidence[0].reference).toBe(
      "https://example.org/research",
    );
    expect(snapshot.discovery.evidence[0].limitations).toEqual([
      "Pricing not established",
    ]);
  });
});
