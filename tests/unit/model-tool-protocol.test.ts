import { expect, it, vi } from "vitest";
import { ToolCallingModel } from "../../src/tools/tool-model";
import { ModelOutputFormatError } from "../../src/core/interpretation-failure";
import { freshTask } from "../../src/data/fixtures";

const result = (name: string, args: unknown) =>
  Response.json({
    status: "completed",
    output: [
      {
        type: "function_call",
        call_id: "decision-1",
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    ],
  });

const options = [
  {
    name: "web.search",
    description: "Search the public web",
    permission: "read" as const,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "document.create",
    description: "Create a sourced editable document",
    permission: "internal" as const,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        sourceIds: { type: "array", items: { type: "string" } },
      },
      required: ["title", "content", "sourceIds"],
    },
  },
];

it("uses native tool arguments without nested JSON encoding", async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const tool = body.tools[0];

    expect(tool.name).toBe("choose_agent_action");
    expect(tool.parameters.required).toEqual(["name", "arguments"]);
    expect(tool.parameters.properties.arguments.type).toBe("object");
    expect(tool.parameters.properties).not.toHaveProperty("argumentsJson");

    return result("choose_agent_action", {
      name: "document.create",
      arguments: {
        title: "New York golf outing",
        content: "A sourced shortlist with unknown fees and tee times.",
        sourceIds: ["web-1", "web-2"],
      },
    });
  });
  const model = new ToolCallingModel("fixture-key", "test-model", fetcher);
  const task = freshTask("golf-choices", "owner");
  task.messages.push(
    { role: "user", text: "golphing", at: "2026-10-29T12:00:00.000Z" },
    { role: "user", text: "new york", at: "2026-10-29T12:01:00.000Z" },
  );

  const choice = await model.chooseAgentAction(
    "Golf outing in New York; save a usable sourced plan.",
    options,
    [{ tool: "web.search", status: "ok", summary: "Five source leads" }],
    task,
  );

  expect(choice).toEqual({
    name: "document.create",
    arguments: {
      title: "New York golf outing",
      content: "A sourced shortlist with unknown fees and tee times.",
      sourceIds: ["web-1", "web-2"],
    },
  });
  expect(fetcher).toHaveBeenCalledOnce();
});

it("repairs malformed proposals without repeating research", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      result("choose_agent_action", {
        name: "document.create",
        argumentsJson: '{"title":"Golf outing"}',
      }),
    )
    .mockResolvedValueOnce(
      result("choose_agent_action", {
        name: "document.create",
        arguments: {
          title: "Golf outing",
          content: "Saved research with source leads and practical unknowns.",
          sourceIds: ["web-1"],
        },
      }),
    );
  const model = new ToolCallingModel("fixture-key", "test-model", fetcher);
  const choice = await model.chooseAgentAction(
    "Follow up on researched golf courses in New York",
    options,
    [{ tool: "web.search", status: "ok", summary: "Five real leads" }],
    freshTask("golf-recovery", "owner"),
  );

  expect(choice.name).toBe("document.create");
  expect(fetcher).toHaveBeenCalledTimes(2);
  const repaired = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
  expect(repaired.input.at(-1).content).toContain("previous response");
  expect(repaired.input.at(-1).role).toBe("system");
  // The model read-only proposal was repeated; no research tool was invoked.
});

it("classifies malformed proposals without recording raw output", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    result("choose_agent_action", "{truncated sensitive source contents"),
  );
  const model = new ToolCallingModel("fixture-key", "test-model", fetcher);
  await expect(
    model.chooseAgentAction(
      "Find golf in New York",
      options,
      [],
      freshTask("golf-invalid", "owner"),
    ),
  ).rejects.toMatchObject({
    stage: "agent.decision",
    reason: "invalid JSON",
  } satisfies Partial<ModelOutputFormatError>);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("never retries upstream provider failure as a schema repair", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response("Provider service unavailable", { status: 503 }),
  );
  const model = new ToolCallingModel("fixture-key", "test-model", fetcher);
  await expect(
    model.chooseAgentAction(
      "Find golf in New York",
      options,
      [],
      freshTask("golf-upstream", "owner"),
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(fetcher).toHaveBeenCalledOnce();
});

it("repairs research synthesis with existing source IDs", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(result("submit_research_answer", "invalid:JSON"))
    .mockResolvedValueOnce(
      result("submit_research_answer", {
        text: "NYC golf sources found [web-1]. Pricing remains unknown.",
        sourceIds: ["web-1"],
      }),
    );
  const model = new ToolCallingModel("fixture-key", "test-model", fetcher);
  const output = await model.synthesizeResearch(
    "Plan golf with friends in New York",
    [
      {
        id: "web-1",
        title: "Golf NYC",
        url: "https://golfnyc.com",
        snippet: "New York City public golf",
        retrievedAt: "2026-10-29T12:00:00.000Z",
      },
    ],
    freshTask("golf-synthesis", "owner"),
  );

  expect(output.sourceIds).toEqual(["web-1"]);
  expect(output.text).toContain("unknown");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
