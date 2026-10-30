import { expect, it, vi } from "vitest";
import { runUnifiedAgent } from "../../src/core/unified-agent";
import { freshTask } from "../../src/data/fixtures";
import { SqliteTaskStore } from "../../src/data/store";

it("research tasks require an observed public source before document creation", async () => {
  const store = new SqliteTaskStore(":memory:");
  const task = freshTask("research-first", "owner");
  store.create(task);
  const choices = vi.fn(
    async (
      _goal: string,
      tools: { name: string }[],
      observations: { tool: string }[],
    ) => {
      if (observations.length === 0) {
        expect(tools.map((tool) => tool.name)).toEqual(["web.search"]);

        return {
          name: "web.search",
          arguments: { query: "electric vehicle charging infrastructure" },
        };
      }

      if (observations.length === 1) {
        expect(tools.some((tool) => tool.name === "document.create")).toBe(
          true,
        );

        return {
          name: "document.create",
          arguments: {
            title: "Provisional industry report",
            content:
              "A public source discusses charging infrastructure. Exact market share, prices and forecasts remain unverified.",
            sourceIds: ["web-1"],
            fulfills: ["report"],
          },
        };
      }

      return { name: "agent.finish", arguments: {} };
    },
  );

  try {
    const result = await runUnifiedAgent({
      task,
      store,
      owner: "owner",
      goal: "Research electric vehicle charging infrastructure and save a report.",
      model: {
        interpret: vi.fn(),
        interpretAgentRequirements: async () => ({
          culturalDecision: false,
          culturalReferences: [],
          deliverables: ["report"],
        }),
        chooseAgentAction: choices,
      },
      research: {
        available: true,
        research: vi.fn(),
        searchOnce: async () => ({
          status: "partial" as const,
          requests: 1,
          sources: [
            {
              id: "official-result",
              title: "Real encyclopedia background",
              url: "https://en.wikipedia.org/wiki/Charging_station",
              snippet: "Charging station overview",
              retrievedAt: "2026-10-30T00:00:00.000Z",
            },
          ],
          warning: "Background only, not up-to-date industry figures.",
        }),
      },
      trace: vi.fn(),
    });

    expect(result.status).toBe("ok");
    expect(task.agentRun?.steps.map((step) => step.tool)).toEqual([
      "web.search",
      "document.create",
    ]);
    expect(task.artifacts[0].evidenceIds).toHaveLength(1);
    expect(store.load(task.id, "owner").artifacts).toEqual(task.artifacts);
  } finally {
    store.close();
  }
});

it("does not retry indefinitely when a public research provider fails", async () => {
  const store = new SqliteTaskStore(":memory:");
  const task = freshTask("research-unavailable", "owner");
  store.create(task);
  const search = vi.fn(async () => ({
    status: "error" as const,
    requests: 1,
    sources: [],
    warning: "Research source unavailable",
  }));
  const choose = vi.fn(async (
    _goal: string,
    tools: { name: string }[],
    observations: { tool: string }[],
  ) => {
    const canSearch = tools.some((tool) => tool.name === "web.search");

    if (observations.length < 2) {
      expect(canSearch).toBe(true);

      return {
        name: "web.search",
        arguments: {
          query:
            observations.length === 0
              ? "charging market"
              : "charging infrastructure alternatives",
        },
      };
    }

    expect(canSearch).toBe(false);

    return {
      name: "document.create",
      arguments: {
        title: "Unverified market notes",
        content:
          "The live research provider was unavailable. These notes contain no sourced market assertions. Research must continue later.",
        fulfills: ["report"],
      },
    };
  });

  try {
    await runUnifiedAgent({
      task,
      store,
      owner: "owner",
      goal: "Research the charging market and save a report.",
      model: {
        interpret: vi.fn(),
        interpretAgentRequirements: async () => ({
          culturalDecision: false,
          culturalReferences: [],
          deliverables: ["report"],
        }),
        chooseAgentAction: choose,
      },
      research: { available: true, research: vi.fn(), searchOnce: search },
      trace: vi.fn(),
    });

    expect(search).toHaveBeenCalledTimes(2);
    expect(task.agentRun?.acceptance?.status).not.toBe("satisfied");
    expect(store.load(task.id, "owner").agentRun?.status).toBe(
      "partially_completed",
    );
  } finally {
    store.close();
  }
});
