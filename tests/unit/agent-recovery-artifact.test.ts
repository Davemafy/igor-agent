import { describe, expect, it, vi } from "vitest";
import { runUnifiedAgent } from "../../src/core/unified-agent";
import { freshTask } from "../../src/data/fixtures";
import { SqliteTaskStore } from "../../src/data/store";

describe("agent evidence survival after a failed model decision", () => {
  it("saves a source-linked, explicitly incomplete workpad after research succeeds", async () => {
    const store = new SqliteTaskStore(":memory:");
    const task = freshTask("real-observations", "owner");
    store.create(task);
    let decisions = 0;

    try {
      const result = await runUnifiedAgent({
        task,
        store,
        owner: "owner",
        goal: "Research the EV charging market and save an investment memo",
        model: {
          async interpret() {
            throw Error("Not used");
          },
          async interpretAgentRequirements() {
            return {
              culturalDecision: false,
              culturalReferences: [],
              deliverables: ["investment memo"],
            };
          },
          async chooseAgentAction() {
            decisions++;

            if (decisions === 1) {
              return {
                name: "web.search",
                arguments: { query: "EV charging market evidence" },
              };
            }

            throw Error("The model provider returned HTTP 503");
          },
        },
        research: {
          research: vi.fn(),
          searchOnce: async () => ({
            status: "ok" as const,
            requests: 1,
            sources: [
              {
                id: "observed-result",
                title: "Official source",
                url: "https://example.org/charging",
                snippet: "A provider observation",
                retrievedAt: "2026-10-30T00:00:00.000Z",
              },
            ],
          }),
        },
        trace: vi.fn(),
      });

      expect(decisions).toBe(2);
      expect(result.status).toBe("partial");
      expect(task.agentRun?.status).toBe("partially_completed");
      expect(task.agentRun?.acceptance?.status).toBe("blocked");
      expect(task.artifacts).toHaveLength(1);
      const artifact = task.artifacts[0];
      expect(artifact.title).toBe("Incomplete evidence workpad");
      expect(artifact.content).toContain("https://example.org/charging");
      expect(artifact.content).toContain("NOT complete");
      expect(artifact.fulfills).toBeUndefined();
      expect(artifact.evidenceIds).toEqual([
        `${task.id}:agent:${task.agentRun?.id}:web-1`,
      ]);
      expect(store.load(task.id, "owner").artifacts).toEqual(task.artifacts);
      expect(task.agentRun?.outputArtifactIds).toContain(artifact.id);
    } finally {
      store.close();
    }
  });

  it("never fabricates an artifact without actual observations", async () => {
    const store = new SqliteTaskStore(":memory:");
    const task = freshTask("no-observations", "owner");
    store.create(task);

    try {
      await runUnifiedAgent({
        task,
        store,
        owner: "owner",
        goal: "Research the market and save a report",
        model: {
          async interpret() {
            throw Error("Not used");
          },
          async interpretAgentRequirements() {
            return {
              culturalDecision: false,
              culturalReferences: [],
              deliverables: ["report"],
            };
          },
          async chooseAgentAction() {
            throw Error("Provider unavailable before any tool");
          },
        },
        research: { research: vi.fn() },
        trace: vi.fn(),
      });

      expect(task.artifacts).toEqual([]);
      expect(task.agentRun?.status).toBe("partially_completed");
    } finally {
      store.close();
    }
  });
});
