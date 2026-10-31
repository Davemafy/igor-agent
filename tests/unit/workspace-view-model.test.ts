import { describe, expect, it } from "vitest";
import { freshTask, sampleCatalogue } from "../../src/data/fixtures";
import { adaptTaskForPresentation } from "../../src/components/workspace-view-model";

describe("workspace presentation adapter", () => {
  it("rejects invalid canonical task payloads", () => {
    expect(() => adaptTaskForPresentation({})).toThrow();
    const task = freshTask("view-invalid", "owner");
    expect(() => adaptTaskForPresentation({ ...task, status: "unsupported-status" })).toThrow();
  });

  it("preserves canonical IDs, participant identity and unknowns", () => {
    const task = freshTask("view-basic", "owner");
    task.brief.selected = ["moonrise"];
    const view = adaptTaskForPresentation(task);

    expect(view.id).toBe(task.id);
    expect(view.revision).toBe(task.brief.version);
    expect(view.participants).toEqual(task.brief.participants);
    expect(view.selectedIds).toEqual(["moonrise"]);
    expect(view.selectedCandidates[0].id).toBe("moonrise");
    expect(view.culturalSignalsForCandidate("moonrise")).toEqual([]);
    expect(view.mapPlaces).toEqual([]);
    expect(view.candidateById.get("unknown")?.available).toBeNull();
    expect(view.evidenceForCandidate("moonrise")).toEqual([]);
  });

  it("only exposes provider-backed, non-sample, geocoded places as map pins", () => {
    const task = freshTask("view-map", "owner");
    const basic = sampleCatalogue()[0];
    task.catalogue.push({
      ...basic,
      id: "verified-place",
      name: "Verified coordinates from a provider",
      type: "place",
      sample: false,
      providerId: "qloo-verified-place",
      place: {
        latitude: 40.731,
        longitude: -73.989,
        address: "Address from provider",
        website: null,
        locality: null,
      },
    });
    task.catalogue.push({
      ...basic,
      id: "sample-place",
      name: "Illustrative place",
      type: "place",
      sample: true,
      place: {
        latitude: 40.73,
        longitude: -73.99,
        address: "Sample, not a provider location",
        website: null,
        locality: null,
      },
    });
    const view = adaptTaskForPresentation(task);

    expect(view.mapPlaces.map((place) => place.candidate.id)).toEqual([
      "verified-place",
    ]);
    expect(view.mapPlaces[0]).toMatchObject({
      latitude: 40.731,
      longitude: -73.989,
    });
    expect(view.candidates.some((item) => item.id === "sample-place")).toBe(true);
  });

  it("never treats context Qloo evidence as a person's score", () => {
    const task = freshTask("view-qloo", "owner");
    task.catalogue[0].cultural = {
      amara: {
        signalScope: "participant",
        rank: 2,
        affinity: 0.62,
        queryId: "amara-query",
        seedIds: ["amara-seed"],
        explanationScope: "recommendation",
        explanationEntities: [{ entity_id: "contributor" }],
        delivery: "CACHED",
        retrievedAt: "2026-10-30T00:00:00Z",
      },
      group: {
        signalScope: "context",
        rank: 1,
        affinity: null,
        queryId: "group-query",
        seedIds: [],
        explanationScope: "aggregate-query",
        explanationEntities: [],
        delivery: "CACHED",
        retrievedAt: "2026-10-30T00:00:00Z",
      },
    };
    const view = adaptTaskForPresentation(task);
    const signals = view.culturalSignalsForCandidate("moonrise");

    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      participantId: "amara",
      participantName: "Amara",
      rankWithinQuery: 2,
      rawAffinity: 0.62,
      queryId: "amara-query",
      delivery: "CACHED",
    });
    expect(signals[1]).toMatchObject({
      participantId: null,
      scope: "context",
      rawAffinity: null,
      queryId: "group-query",
    });
  });
});
