import { describe, expect, it, vi } from "vitest";
import {
  createAgentToolRegistry,
  type AgentToolContext,
} from "../../src/core/agent-tool-registry";
import { freshTask } from "../../src/data/fixtures";

function setup() {
  const task = freshTask("saved-qloo-seeds", "owner");
  task.mode = "qloo-live";
  task.catalogue = [];
  task.entities = [
    {
      id: "seed:sade",
      original: "Sade",
      name: "Sade",
      type: "artist",
      providerId: "65726539-EA36-4283-914C-6EC71001F1F1",
      status: "resolved",
      metadata: "Qloo identity",
      choices: [],
    },
    {
      id: "seed:radiohead",
      original: "Radiohead",
      name: "Radiohead",
      type: "artist",
      providerId: "70CAE5BF-2F4C-445C-A3E5-4EDACFC3591C",
      status: "resolved",
      metadata: "Qloo identity",
      choices: [],
    },
  ];
  const discover = vi.fn(async () => ({
    status: "ok" as const,
    requestCount: 1,
    warnings: [],
    evidenceIds: [],
    retry: "never" as const,
    data: { options: [], evidence: [] },
  }));
  const context: AgentToolContext = {
    task,
    sources: [],
    runId: "test-run",
    research: { research: vi.fn() },
    cultural: { resolve: vi.fn(), discover },
  };
  const tool = createAgentToolRegistry(context).find(
    (entry) => entry.name === "qloo.discover",
  );

  if (!tool) {
    throw new Error("Missing Qloo discovery capability");
  }

  return { task, context, discover, tool };
}

describe("live Qloo discovery identity handoff", () => {
  it.each([
    ["seed:sade"],
    ["65726539-EA36-4283-914C-6EC71001F1F1"],
    ["sAdE"],
  ])("accepts only an already resolved Sade reference: %s", async (id) => {
    const { context, tool, discover } = setup();
    const result = await tool.execute(
      { entityId: id, targetType: "movie" },
      context,
    );

    expect(result.status).toBe("ok");
    expect(result.culturalSeedIds).toEqual([
      "65726539-EA36-4283-914C-6EC71001F1F1",
    ]);
    expect(discover).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({
        anchor: expect.objectContaining({
          name: "Sade",
          providerId: "65726539-EA36-4283-914C-6EC71001F1F1",
        }),
      }),
    );
  });

  it("rejects unobserved identity without issuing a Qloo request", async () => {
    const { context, tool, discover } = setup();
    const result = await tool.execute(
      { entityId: "invented-artist", targetType: "movie" },
      context,
    );

    expect(result.status).toBe("blocked");
    expect(result.requests).toBe(0);
    expect(discover).not.toHaveBeenCalled();
  });

  it("rejects ambiguous names and still accepts a unique internal ID", async () => {
    const { context, task, tool, discover } = setup();
    task.entities.push({
      id: "seed:second-sade",
      original: "Sade",
      name: "Sade",
      type: "person",
      providerId: "11111111-1111-4111-8111-111111111111",
      status: "resolved",
      metadata: "Another person with same name",
      choices: [],
    });

    const ambiguous = await tool.execute(
      { entityId: "Sade", targetType: "movie" },
      context,
    );
    expect(ambiguous.status).toBe("blocked");
    expect(discover).not.toHaveBeenCalled();

    const explicit = await tool.execute(
      { entityId: "seed:sade", targetType: "movie" },
      context,
    );
    expect(explicit.status).toBe("ok");
    expect(discover).toHaveBeenCalledOnce();
  });
});
