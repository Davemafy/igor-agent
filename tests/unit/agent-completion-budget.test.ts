import { expect, it, vi } from "vitest";
import { runUnifiedAgent } from "../../src/core/unified-agent";
import { freshTask } from "../../src/data/fixtures";
import { SqliteTaskStore } from "../../src/data/store";

it("reserves the final agent steps for a requested saved deliverable", async () => {
  const oldSteps = process.env.IGOR_AGENT_MAX_STEPS;
  process.env.IGOR_AGENT_MAX_STEPS = "3";
  const store = new SqliteTaskStore(":memory:");
  const task = freshTask("bounded-report", "owner");
  store.create(task);

  const choose = vi.fn(
    async (
      _goal: string,
      offered: { name: string }[],
      observed: { tool: string }[],
    ) => {
      if (observed.length === 0) {
        return {
          name: "web.search",
          arguments: { query: "EV charging industry report" },
        };
      }

      if (observed.length === 1) {
        expect(offered.map((tool) => tool.name)).toEqual(["document.create"]);

        return {
          name: "document.create",
          arguments: {
            title: "EV charging industry report",
            content:
              "A provisional research brief using the observed source. " +
              "Market figures and company claims require further verification.",
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
      goal: "Research EV charging and save an editable report",
      model: {
        interpret: vi.fn(),
        interpretAgentRequirements: async () => ({
          culturalDecision: false,
          culturalReferences: [],
          deliverables: ["report"],
        }),
        chooseAgentAction: choose,
      },
      research: {
        research: vi.fn(),
        searchOnce: async () => ({
          status: "ok" as const,
          requests: 1,
          sources: [
            {
              id: "source",
              title: "Industry reference",
              url: "https://example.org/industry",
              snippet: "Public research source",
              retrievedAt: "2026-10-30T00:00:00.000Z",
            },
          ],
        }),
      },
      trace: vi.fn(),
    });

    expect(choose).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("ok");
    expect(task.artifacts).toHaveLength(1);
    expect(task.artifacts[0].fulfills).toContain("report");
    expect(task.agentRun?.acceptance?.status).toBe("satisfied");
    expect(store.load(task.id, "owner").artifacts).toHaveLength(1);
  } finally {
    store.close();

    if (oldSteps === undefined) {
      delete process.env.IGOR_AGENT_MAX_STEPS;
    } else {
      process.env.IGOR_AGENT_MAX_STEPS = oldSteps;
    }
  }
});

it("repairs invalid document arguments without discarding observed research", async () => {
  const oldSteps = process.env.IGOR_AGENT_MAX_STEPS;
  process.env.IGOR_AGENT_MAX_STEPS = "6";
  const store = new SqliteTaskStore(":memory:");
  const task = freshTask("rejected-composition", "owner");
  store.create(task);

  const choose = vi.fn(
    async (
      _goal: string,
      offered: { name: string }[],
      observed: { tool: string }[],
    ) => {
      if (observed.length === 0) {
        return {
          name: "web.search",
          arguments: { query: "EV charging overview" },
        };
      }

      if (observed.length === 1) {
        expect(offered.map((tool) => tool.name)).toEqual(["document.create"]);

        return { name: "document.create", arguments: {} };
      }

      if (observed.length === 2) {
        expect(offered.map((tool) => tool.name)).toEqual(["document.create"]);

        return {
          name: "document.create",
          arguments: {
            title: "Provisional EV charging brief",
            content: "Observed source and explicitly unknown market figures.",
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
      goal: "Research EV charging and save a report",
      model: {
        interpret: vi.fn(),
        interpretAgentRequirements: async () => ({
          culturalDecision: false,
          culturalReferences: [],
          deliverables: ["report"],
        }),
        chooseAgentAction: choose,
      },
      research: {
        research: vi.fn(),
        searchOnce: async () => ({
          status: "ok" as const,
          requests: 1,
          sources: [
            {
              id: "original",
              title: "Observed source",
              url: "https://example.org/charging",
              snippet: "A web result",
              retrievedAt: "2026-10-30T00:00:00.000Z",
            },
          ],
        }),
      },
      trace: vi.fn(),
    });

    expect(choose).toHaveBeenCalledTimes(4);
    expect(task.agentRun?.steps.map((step) => step.tool)).toEqual([
      "web.search",
      "document.create",
      "document.create",
    ]);
    expect(task.agentRun?.steps[1].summary).toContain("invalid_type");
    expect(result.status).toBe("ok");
    expect(task.artifacts[0].fulfills).toContain("report");
    expect(store.load(task.id, "owner").artifacts).toHaveLength(1);
  } finally {
    store.close();

    if (oldSteps === undefined) {
      delete process.env.IGOR_AGENT_MAX_STEPS;
    } else {
      process.env.IGOR_AGENT_MAX_STEPS = oldSteps;
    }
  }
});
