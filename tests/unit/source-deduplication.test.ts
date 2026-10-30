import { describe, expect, it } from "vitest";
import {
  createAgentToolRegistry,
  type AgentToolContext,
} from "../../src/core/agent-tool-registry";
import { freshTask } from "../../src/data/fixtures";

function context(): AgentToolContext {
  const existing = {
    id: "web-1",
    title: "Existing venue",
    url: "https://example.org/venue",
    snippet: "Already observed",
    retrievedAt: "2026-10-30T00:00:00.000Z",
  };

  return {
    task: freshTask("source-dedupe", "owner"),
    runId: "test-run",
    sources: [existing],
    research: {
      research: async () => ({
        status: "ok",
        requests: 1,
        sources: [{ ...existing, id: "returned-id" }],
      }),
    },
    places: {
      search: async () => ({
        status: "ok",
        requests: 1,
        places: [
          {
            id: "google-1",
            name: "Existing venue",
            address: "A sourced address",
            url: "https://example.org/venue",
            website: null,
            latitude: 40.72,
            longitude: -73.99,
          },
        ],
      }),
    },
  };
}

describe("source observations are not re-issued as fresh evidence", () => {
  it("does not return previous sources as new web results", async () => {
    const ctx = context();
    const tool = createAgentToolRegistry(ctx).find(
      (entry) => entry.name === "web.search",
    );
    expect(tool).toBeDefined();

    const result = await tool!.execute({ query: "existing venue details" }, ctx);
    expect(result.status).toBe("partial");
    expect(result.sources).toEqual([]);
    expect(ctx.sources).toHaveLength(1);
    expect(result.summary).toContain("0 new unique sources");
  });

  it("does not report old place links as newly discovered sources", async () => {
    const ctx = context();
    const tool = createAgentToolRegistry(ctx).find(
      (entry) => entry.name === "places.search",
    );
    expect(tool).toBeDefined();

    const result = await tool!.execute({ query: "existing venue address" }, ctx);
    expect(result.sources).toEqual([]);
    expect(ctx.sources).toHaveLength(1);
    expect(result.summary).toContain("0 sourced map links");
  });

  it("still returns newly discovered source IDs on a real new search", async () => {
    const ctx = context();
    ctx.research.searchOnce = async () => ({
      status: "ok",
      requests: 1,
      sources: [
        {
          id: "provider-id",
          title: "New source",
          url: "https://example.org/new",
          snippet: "Newly observed",
          retrievedAt: "2026-10-30T00:00:00.000Z",
        },
      ],
    });

    const tool = createAgentToolRegistry(ctx).find(
      (entry) => entry.name === "web.search",
    );
    const result = await tool!.execute({ query: "find a new source" }, ctx);

    expect(result.status).toBe("ok");
    expect(result.sources?.map((source) => source.id)).toEqual(["web-2"]);
    expect(ctx.sources).toHaveLength(2);
  });
});
