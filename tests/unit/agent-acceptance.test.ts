import { describe, it, expect } from "vitest";
import { freshTask, sampleCatalogue } from "../../src/data/fixtures";
import { verifyAgentOutcome } from "../../src/core/agent-acceptance";
import { SqliteTaskStore } from "../../src/data/store";
import { runUnifiedAgent } from "../../src/core/unified-agent";

describe("server outcome acceptance", () => {
  it("does not complete a requested pitch merely because the model finished after search", async () => {
    const store = new SqliteTaskStore(":memory:");
    const task = freshTask("pitch", "owner");
    store.create(task);

    try {
      await runUnifiedAgent({
        task,
        store,
        owner: "owner",
        goal: "Research and draft a partner pitch",
        trace() {},
        research: {
          research: async () => ({
            status: "ok",
            requests: 1,
            sources: [
              {
                id: "web-1",
                title: "Source",
                url: "https://example.org",
                snippet: "A source",
                retrievedAt: new Date().toISOString(),
              },
            ],
          }),
        },
        model: {
          interpret: async () => {
            throw Error("unused");
          },
          chooseAgentAction: async (_goal, _tools, observed) =>
            observed.length
              ? { name: "agent.finish", arguments: {} }
              : {
                  name: "web.search",
                  arguments: { query: "partner evidence" },
                },
        },
      });
      expect(task.agentRun?.status).toBe("partially_completed");
      expect(task.agentRun?.acceptance?.checks[0].status).toBe("unknown");
      expect(store.load(task.id, "owner").agentRun?.acceptance).toEqual(
        task.agentRun?.acceptance,
      );
      expect(verifyAgentOutcome(task, "Use Qloo", true).status).toBe("unknown");
    } finally {
      store.close();
    }
  });
});

it("revises a saved artifact without changing identity and refuses manually edited work", async () => {
  const { createAgentToolRegistry } =
    await import("../../src/core/agent-tool-registry");
  const task = freshTask("revision", "owner");
  task.artifacts.push({
    id: "agent-doc-previous-1",
    kind: "research-report",
    title: "Partner pitch",
    content: "Previously saved pitch that will be revised.",
    version: 1,
    dependencies: [],
    evidenceIds: [],
    assumptions: [],
    freshness: "current",
    edited: false,
  });
  const context = {
    task,
    research: {
      research: async () => ({
        status: "blocked" as const,
        requests: 0,
        sources: [],
      }),
    },
    sources: [],
    runId: "next",
  };
  const tool = createAgentToolRegistry(context).find(
    (t) => t.name === "document.revise",
  )!;
  const args = {
    artifactId: task.artifacts[0].id,
    title: "Partner pitch",
    content: "Revised cultural direction; the approved budget is unchanged.",
    sourceIds: [],
  };
  expect((await tool.execute(args, context)).status).toBe("ok");
  expect(task.artifacts).toHaveLength(1);
  expect(task.artifacts[0].id).toBe("agent-doc-previous-1");
  task.artifacts[0].edited = true;
  expect(
    (
      await tool.execute(
        { ...args, content: "Do not replace my edit with this text." },
        context,
      )
    ).status,
  ).toBe("blocked");
  expect(task.artifacts[0].content).toBe(args.content);
});

const brooklyn =
  "I run a 100-capacity space in Brooklyn. Our community loves Radiohead, Sade and Wong Kar-wai films. Design an unexpected Saturday experience, keep the proposed production budget under $3,000, and give me something I can pitch to partners.";
const revision =
  "Actually, replace Radiohead with Bad Bunny. Keep the budget and everything we've already approved. Show me why the creative direction changes.";

function culturalTask() {
  const task = freshTask("brooklyn", "owner");
  task.brief.constraints.budget = 3000;
  task.entities = ["Radiohead", "Sade", "Wong Kar-wai", "Bad Bunny"].map(
    (name, i) => ({
      id: `seed-${i}`,
      name,
      original: name,
      type: i === 2 ? ("movie" as const) : ("artist" as const),
      providerId: `provider-${i}`,
      status: "resolved" as const,
      metadata: "unit provider response",
      choices: [],
    }),
  );
  task.agentRun = {
    id: "11111111-1111-4111-8111-111111111111",
    goal: brooklyn,
    status: "verifying",
    startedAt: "2026-10-28T00:00:00Z",
    updatedAt: "2026-10-28T00:00:00Z",
    maxSteps: 8,
    maxRequests: 8,
    requests: 2,
    modelSteps: 2,
    steps: [],
    sources: [],
    warnings: [],
    requirements: {
      culturalDecision: true,
      culturalReferences: ["Radiohead", "Sade", "Wong Kar-wai"],
      deliverables: ["proposal", "budget", "partner-pitch"],
    },
  };
  task.catalogue = [];
  task.artifacts = [
    {
      id: `agent-doc-${task.agentRun.id}-1`,
      kind: "creative-brief",
      title: "Brooklyn partner proposal",
      content:
        "Unit test proposal. Estimated production budget $2,800. Availability unknown.",
      version: 1,
      dependencies: [],
      evidenceIds: [],
      candidateIds: ["direction"],
      fulfills: ["proposal", "budget", "partner-pitch"],
      assumptions: [],
      freshness: "current",
      edited: false,
    },
  ];

  return task;
}

function bindCulture(
  task: ReturnType<typeof culturalTask>,
  seeds: string[],
  query = "current",
) {
  const id = `qloo:${query}:context:direction-provider`;
  task.evidence.push({
    id,
    source: "provider-returned",
    kind: "cultural",
    delivery: "CACHED",
    at: "2026-10-28T00:00:00Z",
    entityIds: ["direction-provider"],
    reference: `qloo:${query}`,
    summary: "Unit provider-boundary signal, not live proof",
    limitations: [],
    explanation: null,
    dependencies: [],
    freshness: "current",
  });
  const candidate = {
    ...sampleCatalogue()[0],
    id: "direction",
    providerId: "direction-provider",
    sample: false,
    cultural: {
      context: {
        signalScope: "context" as const,
        affinity: null,
        rank: 1,
        queryId: query,
        seedIds: seeds,
        delivery: "CACHED" as const,
        retrievedAt: "2026-10-28T00:00:00Z",
        explanationEntities: [],
      },
    },
  };
  task.catalogue = [candidate];
  task.artifacts[0].evidenceIds = [id];
}

it("Brooklyn needs current decision-linked cultural evidence although it never says Qloo", () => {
  const task = culturalTask();
  expect(brooklyn).not.toMatch(/qloo/i);
  expect(verifyAgentOutcome(task, brooklyn, true).status).toBe("unknown");
  bindCulture(task, ["provider-0", "provider-1", "provider-2"]);
  expect(verifyAgentOutcome(task, brooklyn, true).status).toBe("satisfied");
  task.artifacts[0].evidenceIds = [];
  expect(verifyAgentOutcome(task, brooklyn, true).status).toBe("unknown");
});
it("Bad Bunny revision rejects old Radiohead evidence, preserves the budget and approved work, and accepts newly bound evidence", () => {
  const task = culturalTask();
  bindCulture(task, ["provider-0", "provider-1", "provider-2"]);
  const approved = {
    ...task.artifacts[0],
    id: "approved-independent",
    locked: true,
    content: "Approved wording and budget are retained exactly.",
  };
  task.artifacts.push(approved);
  const before = JSON.stringify(approved);
  task.agentRun!.requirements!.culturalReferences = [
    "Bad Bunny",
    "Sade",
    "Wong Kar-wai",
  ];
  expect(verifyAgentOutcome(task, revision, true).status).toBe("unknown");
  bindCulture(task, ["provider-3", "provider-1", "provider-2"], "revised");
  expect(verifyAgentOutcome(task, revision, true).status).toBe("satisfied");
  expect(task.brief.constraints.budget).toBe(3000);
  expect(JSON.stringify(approved)).toBe(before);
  task.evidence.at(-1)!.freshness = "stale";
  expect(verifyAgentOutcome(task, revision, true).status).toBe("unknown");
});

it("executes the Brooklyn revision against persisted work; stale Radiohead evidence cannot complete it", async () => {
  const task = culturalTask();
  bindCulture(task, ["provider-0", "provider-1", "provider-2"], "old");
  const artifactId = task.artifacts[0].id;
  const originalContent = task.artifacts[0].content;
  const approved = {
    ...task.artifacts[0],
    id: "approved-independent",
    locked: true,
    content: "Approved production agreement",
  };
  task.artifacts.push(approved);
  const originalApproved = structuredClone(approved);
  const store = new SqliteTaskStore(":memory:");
  store.create(task);

  try {
    await runUnifiedAgent({
      task,
      store,
      owner: "owner",
      goal: revision,
      trace() {},
      research: {
        research: async () => ({ status: "blocked", requests: 0, sources: [] }),
      },
      model: {
        interpret: async () => {
          throw Error("unused");
        },
        interpretAgentRequirements: async () => ({
          culturalDecision: true,
          culturalReferences: ["Bad Bunny", "Sade", "Wong Kar-wai"],
          deliverables: ["proposal", "budget", "partner-pitch"],
        }),
        chooseAgentAction: async (_goal, _tools, observed) =>
          observed.length
            ? { name: "agent.finish", arguments: {} }
            : {
                name: "document.revise",
                arguments: {
                  artifactId,
                  title: "Revised partner proposal",
                  content:
                    "Replace Radiohead with Bad Bunny. Keep the approved budget under $3,000; this unit example lacks new provider evidence.",
                  sourceIds: [],
                  evidenceIds: ["qloo:old:context:direction-provider"],
                  candidateIds: ["direction"],
                  fulfills: ["proposal", "budget", "partner-pitch"],
                },
              },
      },
    });
    const loaded = store.load(task.id, "owner");
    expect(loaded.agentRun?.status).toBe("partially_completed");
    expect(loaded.agentRun?.requirements?.culturalReferences).toEqual([
      "Bad Bunny",
      "Sade",
      "Wong Kar-wai",
    ]);
    expect(
      loaded.artifacts.find((a) => a.id === artifactId)?.content,
    ).toContain("Bad Bunny");
    expect(loaded.artifacts.find((a) => a.id === artifactId)?.id).toBe(
      artifactId,
    );
    expect(
      loaded.artifactHistory?.some(
        (entry) =>
          entry.artifact.id === artifactId &&
          entry.artifact.content === originalContent,
      ),
    ).toBe(true);
    expect(loaded.artifacts.find((a) => a.id === approved.id)).toEqual(
      originalApproved,
    );
    expect(loaded.brief.constraints.budget).toBe(3000);
  } finally {
    store.close();
  }
});

it("query-qualified context signals retain their original evidence identities", async () => {
  const { culturalEvidenceId } =
    await import("../../src/core/agent-acceptance");
  const task = culturalTask();
  bindCulture(task, ["provider-0", "provider-1", "provider-2"]);
  const signal = task.catalogue[0].cultural!.context;
  task.catalogue[0].cultural = { [`context:${signal.queryId}`]: signal };
  expect(verifyAgentOutcome(task, brooklyn, true).status).toBe("satisfied");
  task.evidence[0].freshness = "stale";
  expect(verifyAgentOutcome(task, brooklyn, true).status).toBe("unknown");
  const candidate = { id: "candidate", providerId: "provider-id" };
  expect(
    culturalEvidenceId(candidate, "context:actual-query", {
      queryId: "actual-query",
      signalScope: "context",
    }),
  ).toBe("qloo:actual-query:context:provider-id");
  expect(
    culturalEvidenceId(candidate, "participant-id", {
      queryId: "actual-query",
      signalScope: "participant",
    }),
  ).toBe("qloo:actual-query:participant-id:provider-id");
});

it("does not invent linked experience obligations for a research-only memo", () => {
  const task = freshTask("research-acceptance", "owner");
  task.agentRun = {
    id: "22222222-2222-4222-8222-222222222222",
    goal: "Research the EV charging market and prepare an investment memo",
    status: "verifying",
    startedAt: "2026-10-30T00:00:00Z",
    updatedAt: "2026-10-30T00:00:00Z",
    maxSteps: 8,
    maxRequests: 8,
    requests: 1,
    modelSteps: 2,
    steps: [],
    sources: [],
    warnings: [],
    requirements: {
      culturalDecision: false,
      culturalReferences: [],
      deliverables: ["investment_memo"],
      experienceDomains: ["budget", "risk"],
    },
  };

  const acceptance = verifyAgentOutcome(
    task,
    task.agentRun.goal,
    true,
  );

  expect(
    acceptance.checks.filter((item) =>
      item.requirement.startsWith("Linked experience decision:"),
    ),
  ).toEqual([]);
  expect(acceptance.status).not.toBe("satisfied");
});

it("revises an agent memo without losing its older verified citations", async () => {
  const { createAgentToolRegistry } =
    await import("../../src/core/agent-tool-registry");
  const task = freshTask("memo-revision", "owner");
  const earlierId = `${task.id}:agent:original:web-1`;
  task.evidence.push({
    id: earlierId,
    source: "provider-returned",
    kind: "practical",
    at: "2026-10-30T00:00:00Z",
    entityIds: [],
    reference: "https://example.org/energy",
    summary: "Previously observed evidence",
    limitations: [],
    explanation: null,
    dependencies: [],
    freshness: "current",
  });
  task.artifacts.push({
    id: "agent-doc-original-1",
    kind: "research-report",
    title: "EV investment memo",
    content: "An earlier evidence-linked investment memo.",
    version: 1,
    dependencies: [],
    evidenceIds: [earlierId],
    fulfills: ["investment_memo"],
    assumptions: [],
    freshness: "current",
    edited: false,
  });
  const ctx = {
    task,
    runId: "following-turn",
    sources: [],
    research: { available: false, research: async () => ({
      status: "blocked" as const, requests: 0, sources: [],
    }) },
  };
  const tool = createAgentToolRegistry(ctx).find(
    (item) => item.name === "document.revise",
  )!;
  const revised = await tool.execute(
    {
      artifactId: "agent-doc-original-1",
      title: "Updated EV investment memo",
      content: "Updated scope and risks; all earlier source claims remain attributed.",
      sourceIds: ["web-1"],
    },
    ctx,
  );

  expect(revised.status).toBe("ok");
  expect(task.artifacts[0].evidenceIds).toEqual([earlierId]);
  expect(task.artifacts[0].fulfills).toEqual(["investment_memo"]);
  expect(
    (await tool.execute(
      {
        artifactId: "agent-doc-original-1",
        title: "Unverified",
        content: "This edit attempts to inject a missing citation.",
        sourceIds: ["web-999"],
      },
      ctx,
    )).status,
  ).toBe("blocked");
  expect(task.artifacts[0].title).toBe("Updated EV investment memo");
});
