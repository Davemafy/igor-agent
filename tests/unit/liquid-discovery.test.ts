import { afterEach, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LiquidDiscovery } from "../../src/components/liquid-discovery";
import {
  PresentationSchema,
  installPresentation,
  mutateCanvas,
  validatePresentation,
} from "../../src/core/presentation";
import { freshTask, sampleCatalogue } from "../../src/data/fixtures";
import { SqliteTaskStore } from "../../src/data/store";
import { runTurn } from "../../src/core/orchestrator";
import { modelContext } from "../../src/tools/model-context";
import { interpretMessage } from "../../src/core/interpret-message";
import { applyConversationActions } from "../../src/core/conversation";
import { ExecutionBudget } from "../../src/core/execution";
import { ensureBoundPresentation } from "../../src/core/presentation-default";

const stores: SqliteTaskStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

const discovery = PresentationSchema.parse({
  id: "liquid-journey",
  title: "Discover and shape your work",
  basis: "draft",
  root: "choices",
  nodes: [
    {
      id: "choices",
      type: "discovery",
      candidateIds: ["moonrise", "arrival", "spirited"],
    },
  ],
});

const context = {
  candidates: [
    { id: "moonrise", freshness: "current" },
    { id: "arrival", freshness: "current" },
    { id: "spirited", freshness: "current" },
    { id: "stale", freshness: "stale" },
  ],
  evidence: [],
  artifacts: [],
};

function mutate(
  canvas: ReturnType<typeof installPresentation>,
  mutation: Parameters<typeof mutateCanvas>[2],
) {
  return mutateCanvas(canvas, "liquid-journey", mutation, context);
}

it("morphs discovery into grounded comparison and a user-curated plan without inventing entities", () => {
  let canvas = installPresentation(undefined, discovery);
  expect(() =>
    mutate(canvas, { operation: "view", nodeId: "choices", mode: "compare" }),
  ).toThrow(/Select two current/);
  expect(() =>
    mutate(canvas, { operation: "view", nodeId: "choices", mode: "plan" }),
  ).toThrow(/Choose a current/);

  canvas = mutate(canvas, {
    operation: "compare-selection",
    nodeId: "choices",
    candidateId: "moonrise",
  });
  canvas = mutate(canvas, {
    operation: "compare-selection",
    nodeId: "choices",
    candidateId: "arrival",
  });
  canvas = mutate(canvas, {
    operation: "view",
    nodeId: "choices",
    mode: "compare",
  });
  expect(canvas.comparisonIds).toEqual(["moonrise", "arrival"]);
  expect(canvas.viewModes.choices).toBe("compare");

  canvas = mutate(canvas, {
    operation: "select",
    nodeId: "choices",
    candidateId: "arrival",
  });
  canvas = mutate(canvas, {
    operation: "view",
    nodeId: "choices",
    mode: "plan",
  });
  expect(canvas.itineraryIds).toEqual(["arrival"]);
  canvas = mutate(canvas, {
    operation: "itinerary-day",
    nodeId: "choices",
    candidateId: "arrival",
    day: 2,
  });
  canvas = mutate(canvas, {
    operation: "itinerary",
    nodeId: "choices",
    candidateIds: ["arrival", "moonrise"],
  });
  expect(canvas.itineraryIds).toEqual(["arrival", "moonrise"]);
  expect(canvas.itineraryDays.arrival).toBe(2);

  canvas = mutate(canvas, {
    operation: "view",
    nodeId: "choices",
    mode: "explore",
  });
  expect(canvas.comparisonIds).toEqual(["moonrise", "arrival"]);
  expect(canvas.itineraryIds).toEqual(["arrival", "moonrise"]);
  expect(canvas.viewModes.choices).toBe("explore");
});

it("rejects forged, stale, unsupported and insufficient direct UI transitions", () => {
  let canvas = installPresentation(undefined, discovery);

  for (const candidateId of ["forged", "stale"]) {
    expect(() =>
      mutate(canvas, {
        operation: "compare-selection",
        nodeId: "choices",
        candidateId,
      }),
    ).toThrow(/Compare only current/);
  }

  expect(() =>
    mutate(canvas, { operation: "view", nodeId: "missing", mode: "compare" }),
  ).toThrow(/Component not found/);
  canvas = mutate(canvas, {
    operation: "compare-selection",
    nodeId: "choices",
    candidateId: "moonrise",
  });
  canvas = mutate(canvas, {
    operation: "compare-selection",
    nodeId: "choices",
    candidateId: "arrival",
  });
  canvas = mutate(canvas, {
    operation: "view",
    nodeId: "choices",
    mode: "compare",
  });
  canvas = mutate(canvas, {
    operation: "compare-selection",
    nodeId: "choices",
    candidateId: "arrival",
  });
  expect(canvas.viewModes.choices).toBe("explore");
  expect(() =>
    mutateCanvas(
      canvas,
      "old-surface",
      {
        operation: "view",
        nodeId: "choices",
        mode: "explore",
      },
      context,
    ),
  ).toThrow(/replaced/);
});

it("persists selection, comparison, plan and scheduled day through the actual turn route and reload", async () => {
  const task = freshTask("liquid-persisted", "owner");
  task.candidates = sampleCatalogue()
    .slice(0, 3)
    .map((candidate) => ({
      ...candidate,
      eligibility: "eligible" as const,
      dependencies: [],
      freshness: "current" as const,
      missing: [],
      violations: [],
      evidenceIds: [],
      fit: {},
      fitReason: "Illustrative only",
    }));
  task.canvas = installPresentation(
    undefined,
    validatePresentation(discovery, task),
  );
  const store = new SqliteTaskStore(":memory:");
  stores.push(store);
  store.create(task);
  let state = task;
  const actions = [
    {
      operation: "compare-selection",
      nodeId: "choices",
      candidateId: "moonrise",
    },
    {
      operation: "compare-selection",
      nodeId: "choices",
      candidateId: "arrival",
    },
    { operation: "view", nodeId: "choices", mode: "compare" },
    { operation: "select", nodeId: "choices", candidateId: "arrival" },
    { operation: "view", nodeId: "choices", mode: "plan" },
    {
      operation: "itinerary-day",
      nodeId: "choices",
      candidateId: "arrival",
      day: 2,
    },
  ] as const;

  for (const mutation of actions) {
    state = await runTurn(store, state.id, "owner", {
      type: "canvas",
      surfaceId: "liquid-journey",
      mutation,
      version: state.brief.version,
    });
  }

  const restored = store.load(state.id, "owner");
  expect(restored.canvas?.viewModes.choices).toBe("plan");
  expect(restored.canvas?.comparisonIds).toEqual(["moonrise", "arrival"]);
  expect(restored.canvas?.selectedCandidateId).toBe("arrival");
  expect(restored.canvas?.itineraryDays.arrival).toBe(2);
  expect(
    modelContext(restored, "Keep the selected option").canvas?.comparisonIds,
  ).toEqual(["moonrise", "arrival"]);
  expect(
    modelContext(restored, "Keep the selected option").canvas?.viewModes
      .choices,
  ).toBe("plan");

  await expect(
    runTurn(store, state.id, "wrong-owner", {
      type: "canvas",
      surfaceId: "liquid-journey",
      mutation: { operation: "view", nodeId: "choices", mode: "explore" },
      version: state.brief.version,
    }),
  ).rejects.toThrow();
  await expect(
    runTurn(store, state.id, "owner", {
      type: "canvas",
      surfaceId: "liquid-journey",
      mutation: { operation: "view", nodeId: "choices", mode: "explore" },
      version: state.brief.version - 1,
    }),
  ).rejects.toThrow();
  expect(store.load(state.id, "owner").canvas?.viewModes.choices).toBe("plan");
});

it("does not treat an arbitrary short follow-up as consent to a new taste preference", async () => {
  const task = freshTask("short-followup", "owner");
  task.brief.unresolved = [
    "What is one artist, film, book or place you enjoy that could guide this?",
  ];
  const update = await interpretMessage(
    task,
    { type: "message", text: "Go", version: 0 },
    {
      interpret: async () => ({
        intent: "revision",
        kind: "discovery",
        goal: "Continue the existing request",
        supported: true,
        actions: [
          {
            kind: "profile",
            participant: "you",
            preferences: [{ value: "Go", polarity: "like" }],
          },
        ],
      }),
    },
    new ExecutionBudget(),
    () => {},
  );
  expect(update.clarification).toMatch(/Whose taste/);
  expect(update.task.brief.participants).toEqual(task.brief.participants);
});

it("allows a natural-language tool decision to morph only grounded, preselected work", () => {
  const task = freshTask("agent-morph", "owner");
  task.candidates = sampleCatalogue()
    .slice(0, 3)
    .map((candidate) => ({
      ...candidate,
      eligibility: "eligible" as const,
      dependencies: [],
      freshness: "current" as const,
      missing: [],
      violations: [],
      evidenceIds: [],
      fit: {},
      fitReason: "Illustrative only",
    }));
  let canvas = installPresentation(
    undefined,
    validatePresentation(discovery, task),
  );
  canvas = mutate(canvas, {
    operation: "compare-selection",
    nodeId: "choices",
    candidateId: "arrival",
  });
  canvas = mutate(canvas, {
    operation: "compare-selection",
    nodeId: "choices",
    candidateId: "moonrise",
  });
  task.canvas = canvas;
  const result = applyConversationActions(
    task,
    [{ kind: "canvas-view", nodeId: "choices", mode: "compare" }],
    "Compare these two",
  );
  expect(result.ok).toBe(true);

  if (!result.ok) {
    return;
  }

  expect(result.task.canvas?.viewModes.choices).toBe("compare");
  expect(result.task.candidates).toEqual(task.candidates);
  expect(result.task.brief).toEqual(task.brief);
  expect(task.canvas?.viewModes.choices).toBeUndefined();

  const invalid = applyConversationActions(
    task,
    [{ kind: "canvas-view", nodeId: "fabricated", mode: "plan" }],
    "Plan with the selected option",
  );
  expect(invalid.ok).toBe(false);
  expect(task.canvas?.viewModes.choices).toBeUndefined();
});

it("renders distinctly composed comparison and plan views from persisted state", () => {
  const task = freshTask("render-views", "owner");
  task.candidates = sampleCatalogue()
    .slice(0, 3)
    .map((candidate) => ({
      ...candidate,
      eligibility: "eligible" as const,
      dependencies: [],
      freshness: "current" as const,
      missing: [],
      violations: [],
      evidenceIds: [],
      fit: {},
      fitReason: "Illustrative only",
    }));
  const node = discovery.nodes.find(
    (component) => component.type === "discovery",
  );

  if (!node || node.type !== "discovery") {
    throw Error("Discovery fixture missing");
  }

  task.canvas = installPresentation(undefined, discovery);
  const render = () =>
    renderToStaticMarkup(
      createElement(LiquidDiscovery, {
        task,
        node,
        busy: false,
        mutate: () => {},
        onTurn: () => {},
      }),
    );
  expect(render()).toContain('data-mode="explore"');
  task.canvas = mutate(task.canvas, {
    operation: "compare-selection",
    nodeId: "choices",
    candidateId: "moonrise",
  });
  task.canvas = mutate(task.canvas, {
    operation: "compare-selection",
    nodeId: "choices",
    candidateId: "arrival",
  });
  task.canvas = mutate(task.canvas, {
    operation: "view",
    nodeId: "choices",
    mode: "compare",
  });
  expect(render()).toContain('data-mode="compare"');
  expect(render()).toContain("Look closer");
  task.canvas = mutate(task.canvas, {
    operation: "select",
    nodeId: "choices",
    candidateId: "arrival",
  });
  task.canvas = mutate(task.canvas, {
    operation: "view",
    nodeId: "choices",
    mode: "plan",
  });
  expect(render()).toContain('data-mode="plan"');
  expect(render()).toContain("Draft a plan with Igor");
});

it("commits a spoken comparison view change without calling Qloo or rewriting artifacts", async () => {
  const task = freshTask("spoken-morph", "owner");
  task.candidates = sampleCatalogue()
    .slice(0, 3)
    .map((candidate) => ({
      ...candidate,
      eligibility: "eligible" as const,
      dependencies: [],
      freshness: "current" as const,
      missing: [],
      violations: [],
      evidenceIds: [],
      fit: {},
      fitReason: "Illustrative only",
    }));
  task.canvas = installPresentation(undefined, discovery);
  task.canvas = mutate(task.canvas, {
    operation: "compare-selection",
    nodeId: "choices",
    candidateId: "moonrise",
  });
  task.canvas = mutate(task.canvas, {
    operation: "compare-selection",
    nodeId: "choices",
    candidateId: "arrival",
  });
  const before = structuredClone(task.candidates);
  const store = new SqliteTaskStore(":memory:");
  stores.push(store);
  store.create(task);
  let culturalRequests = 0;
  const updated = await runTurn(
    store,
    task.id,
    "owner",
    { type: "message", text: "Compare the two options I chose", version: 0 },
    undefined,
    {
      get calls() {
        return culturalRequests;
      },
      async resolve() {
        culturalRequests++;
        throw Error("No Qloo needed");
      },
      async discover() {
        culturalRequests++;
        throw Error("No Qloo needed");
      },
    },
    {
      async interpret() {
        return {
          intent: "revision",
          supported: true,
          kind: "discovery",
          goal: "Continue this comparison",
          actions: [
            { kind: "canvas-view", nodeId: "choices", mode: "compare" },
          ],
        };
      },
    },
  );
  expect(culturalRequests).toBe(0);
  expect(updated.canvas?.viewModes.choices).toBe("compare");
  expect(updated.candidates).toEqual(before);
  expect(updated.receipts?.at(-1)?.culturalRequests).toBe(0);
  expect(store.load(task.id, "owner").canvas?.viewModes.choices).toBe(
    "compare",
  );
});

it("shows only stored Qloo query relationships, not invented cross-domain edges", () => {
  const task = freshTask("sourced-connections", "owner");
  task.candidates = sampleCatalogue()
    .slice(0, 3)
    .map((candidate) => ({
      ...candidate,
      eligibility: "eligible" as const,
      dependencies: [],
      freshness: "current" as const,
      missing: [],
      violations: [],
      evidenceIds: [],
      fit: {},
      fitReason: "Illustrative only",
    }));
  task.canvas = installPresentation(undefined, discovery);
  task.canvas = mutate(task.canvas, {
    operation: "view",
    nodeId: "choices",
    mode: "connections",
  });
  const node = discovery.nodes.find(
    (component) => component.type === "discovery",
  );

  if (!node || node.type !== "discovery") {
    throw Error("Missing discovery fixture");
  }

  const render = () =>
    renderToStaticMarkup(
      createElement(LiquidDiscovery, {
        task,
        node,
        busy: false,
        mutate: () => {},
        onTurn: () => {},
      }),
    );

  expect(render()).toContain("No traceable Qloo connection");
  expect(render()).not.toContain("Rank 2 within this query");
  task.candidates[0].evidenceIds = ["qloo-1"];
  task.candidates[0].cultural = {
    user: {
      affinity: null,
      rank: 2,
      queryId: "query-42",
      seedIds: ["seed-recorded"],
      explanationEntities: [],
      delivery: "CACHED",
      retrievedAt: "2026-10-27T00:00:00.000Z",
    },
  };
  task.evidence = [
    {
      id: "qloo-1",
      kind: "cultural",
      source: "provider-returned",
      delivery: "CACHED",
      at: "2026-10-27T00:00:00.000Z",
      reference: "Recorded provider fixture",
      entityIds: ["seed-recorded"],
      summary: "A recorded cultural recommendation",
      limitations: ["Query seeds do not prove a per-result explanation"],
      explanation: null,
      dependencies: [],
      freshness: "current",
    },
  ];
  expect(render()).toContain("Rank 2 within this query");
  expect(render()).toContain("query-42");
  expect(render()).toContain("Query seed: seed-recorded");
  expect(render()).toContain("A recorded cultural recommendation");
});

it("preserves view and scheduling through legacy canvas rebinding without keeping invalid comparisons", () => {
  const task = freshTask("rebound-canvas", "owner");
  task.candidates = sampleCatalogue()
    .slice(0, 3)
    .map((candidate) => ({
      ...candidate,
      eligibility: "eligible" as const,
      dependencies: [],
      freshness: "current" as const,
      missing: [],
      violations: [],
      evidenceIds: [],
      fit: {},
      fitReason: "Illustrative only",
    }));
  ensureBoundPresentation(task);

  if (!task.canvas) {
    throw Error("Expected adapter canvas");
  }

  expect(task.canvas.source).toBe("adapter");
  let canvas = task.canvas;
  const sid = canvas.surface.id;
  canvas = mutateCanvas(
    canvas,
    sid,
    {
      operation: "compare-selection",
      nodeId: "discoveries",
      candidateId: "moonrise",
    },
    task,
  );
  canvas = mutateCanvas(
    canvas,
    sid,
    {
      operation: "compare-selection",
      nodeId: "discoveries",
      candidateId: "arrival",
    },
    task,
  );
  canvas = mutateCanvas(
    canvas,
    sid,
    { operation: "view", nodeId: "discoveries", mode: "compare" },
    task,
  );
  canvas = mutateCanvas(
    canvas,
    sid,
    { operation: "select", nodeId: "discoveries", candidateId: "arrival" },
    task,
  );
  canvas = mutateCanvas(
    canvas,
    sid,
    { operation: "view", nodeId: "discoveries", mode: "plan" },
    task,
  );
  canvas = mutateCanvas(
    canvas,
    sid,
    {
      operation: "itinerary-day",
      nodeId: "discoveries",
      candidateId: "arrival",
      day: 2,
    },
    task,
  );
  canvas = mutateCanvas(
    canvas,
    sid,
    { operation: "view", nodeId: "discoveries", mode: "compare" },
    task,
  );
  task.canvas = canvas;
  task.brief.version++;
  ensureBoundPresentation(task);
  expect(task.canvas?.comparisonIds).toEqual(["moonrise", "arrival"]);
  expect(task.canvas?.viewModes.discoveries).toBe("compare");
  expect(task.canvas?.itineraryDays.arrival).toBe(2);
  expect(task.canvas?.itineraryIds).toEqual(["arrival"]);

  task.candidates[1].freshness = "stale";
  task.brief.version++;
  ensureBoundPresentation(task);
  expect(task.canvas?.comparisonIds).toEqual(["moonrise"]);
  expect(task.canvas?.viewModes.discoveries).toBe("explore");
});

it("executes revisions of saved agent-created documents instead of swallowing them", async () => {
  const task = freshTask("agent-memo-revision", "owner");
  task.artifacts.push({
    id: "agent-doc-previous-run-1",
    kind: "research-report",
    title: "EV charging investment memo",
    content: "An existing source-cited investment memo to be revised.",
    version: 1,
    dependencies: [],
    evidenceIds: [],
    assumptions: [],
    freshness: "current",
    edited: false,
  });
  const text =
    "Revise the saved investment memo to prioritize charging-network operators. Keep earlier citations.";
  const updated = await interpretMessage(
    task,
    { type: "message", text, version: task.brief.version },
    {
      interpret: async () => {
        throw new Error("The legacy interpretation path must not execute.");
      },
      routeConversation: async () => {
        throw new Error(
          "A read-only route cannot swallow this saved revision.",
        );
      },
    },
    new ExecutionBudget(),
    () => {},
  );

  expect(updated.researchQuery).toBe(text);
  expect(updated.task.artifacts[0].id).toBe("agent-doc-previous-run-1");
  expect(updated.task.messages.at(-1)?.text).toBe(text);
});
