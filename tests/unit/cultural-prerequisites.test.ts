import { describe, expect, it, vi } from "vitest";
import { runUnifiedAgent } from "../../src/core/unified-agent";
import { freshTask } from "../../src/data/fixtures";
import { SqliteTaskStore } from "../../src/data/store";

describe("required cultural discovery dependencies", () => {
  it("resolves and discovers every explicit user-supplied seed before open model decisions", async () => {
    const store = new SqliteTaskStore(":memory:");
    const task = freshTask("multiple-seeds", "owner");
    task.mode = "qloo-live";
    store.create(task);
    const providerIds: Record<string, string> = {
      Sade: "65726539-EA36-4283-914C-6EC71001F1F1",
      Radiohead: "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
    };
    const resolve = vi.fn(async (name: string) => ({
      status: "ok" as const,
      evidenceIds: [],
      retry: "never" as const,
      requestCount: 1,
      warnings: [],
      data: {
        id: `seed:${name}`,
        original: name,
        name,
        type: "artist" as const,
        providerId: providerIds[name],
        status: "resolved" as const,
        metadata: "provider-returned",
        choices: [],
      },
    }));
    const discover = vi.fn(async () => ({
      status: "ok" as const,
      evidenceIds: [],
      retry: "never" as const,
      requestCount: 1,
      warnings: [],
      data: { options: [], evidence: [] },
    }));
    const choose = vi.fn(async () => {
      throw Error("Model unavailable after dependency closure");
    });

    try {
      await runUnifiedAgent({
        task,
        store,
        owner: "owner",
        goal: "Plan a music evening for fans of Sade and Radiohead.",
        requirements: {
          culturalDecision: true,
          culturalReferences: ["Sade", "Radiohead"],
          deliverables: [],
        },
        cultural: { resolve, discover },
        research: {
          available: false,
          research: async () => ({
            status: "blocked" as const,
            requests: 0,
            sources: [],
          }),
        },
        model: {
          interpret: vi.fn(),
          chooseAgentAction: choose,
        },
        trace: vi.fn(),
      });

      expect(resolve.mock.calls.map((args) => args[0])).toEqual([
        "Sade",
        "Radiohead",
      ]);
      expect(discover).toHaveBeenCalledTimes(2);
      expect(task.agentRun?.steps.map((step) => step.tool)).toEqual([
        "qloo.resolve_entity",
        "qloo.discover",
        "qloo.resolve_entity",
        "qloo.discover",
      ]);
      expect(choose).toHaveBeenCalledOnce();
      expect(store.load(task.id, "owner").entities).toHaveLength(2);
      expect(task.agentRun?.acceptance?.status).not.toBe("satisfied");
    } finally {
      store.close();
    }
  });
});
