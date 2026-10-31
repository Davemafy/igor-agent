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

it("repairs a successful response with no native tool call once", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ status: "completed", output: [] }))
    .mockResolvedValueOnce(
      result("choose_agent_action", {
        name: "web.search",
        arguments: { query: "Current New York venues" },
      }),
    );
  const model = new ToolCallingModel("fixture-key", "test-model", fetcher);

  const decision = await model.chooseAgentAction(
    "Find real venues",
    options,
    [],
    freshTask("empty-tool-repair", "owner"),
  );

  expect(decision).toEqual({
    name: "web.search",
    arguments: { query: "Current New York venues" },
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const repaired = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
  expect(repaired.input.at(-1).content).toContain("exactly one valid tool");
});

it("stops after one native tool-call repair with no external action", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ status: "completed", output: [] }),
  );
  const model = new ToolCallingModel("fixture-key", "test-model", fetcher);

  await expect(
    model.chooseAgentAction(
      "Find real venues",
      options,
      [],
      freshTask("empty-tool-blocked", "owner"),
    ),
  ).rejects.toMatchObject({
    stage: "agent.decision",
    reason: "invalid schema",
  } satisfies Partial<ModelOutputFormatError>);
  expect(fetcher).toHaveBeenCalledTimes(2);
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

it("uses the exact document schema when it is the only allowed tool", async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const parameters = body.tools[0].parameters.properties.arguments;

    expect(parameters.type).toBe("object");
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.properties.title.type).toBe("string");
    expect(parameters.properties.sourceIds.type).toBe("array");
    expect(parameters.properties.sourceIds.items.type).toBe("string");

    return result("choose_agent_action", {
      name: "document.create",
      arguments: {
        title: "Sourced review",
        content: "Observed evidence and remaining unknowns.",
        sourceIds: [],
      },
    });
  });
  const model = new ToolCallingModel("fixture-key", "test-model", fetcher);

  const choice = await model.chooseAgentAction(
    "Save the researched report",
    [options[1]],
    [],
    freshTask("single-document", "owner"),
  );

  expect(choice.name).toBe("document.create");
  expect(fetcher).toHaveBeenCalledOnce();
});

it("uses the native connected-experience proposal schema when required", async () => {
  const proposal = {
    name: "experience.propose",
    description: "Save connected cultural decisions and documents",
    permission: "internal" as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        decisions: { type: "array", items: { type: "object" } },
        documents: { type: "array", items: { type: "object" } },
      },
      required: ["title", "decisions", "documents"],
    },
  };
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const argumentSchema = request.tools[0].parameters.properties.arguments;

    expect(argumentSchema.additionalProperties).toBe(false);
    expect(argumentSchema.required).toEqual([
      "title",
      "decisions",
      "documents",
    ]);
    expect(argumentSchema.properties.decisions.type).toBe("array");

    return result("choose_agent_action", {
      name: "experience.propose",
      arguments: {
        title: "A grounded cultural evening",
        decisions: [],
        documents: [],
      },
    });
  });
  const model = new ToolCallingModel("fixture-key", "test-model", fetcher);
  const chosen = await model.chooseAgentAction(
    "Plan the cultural evening",
    [proposal],
    [],
    freshTask("typed-cultural-proposal", "owner"),
  );

  expect(chosen.name).toBe("experience.propose");
});

it("routes an agent-created memo revision back into the persistent agent", async () => {
  const text =
    "Revise the saved investment memo to prioritize charging-network operators. " +
    "Keep the earlier research citations and flag unknown figures.";
  const fetcher = vi.fn<typeof fetch>(async () =>
    result("route_conversation", { intent: "delegate" }),
  );
  const model = new ToolCallingModel("fixture-key", "test-model", fetcher);
  const task = freshTask("revision-route", "owner");
  task.agentRun = {
    id: "11111111-1111-4111-8111-111111111111",
    goal: "Research EV charging and save an investment memo",
    status: "completed",
    startedAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    maxSteps: 8,
    maxRequests: 8,
    requests: 1,
    modelSteps: 2,
    steps: [],
    sources: [],
    warnings: [],
    outputArtifactIds: ["agent-doc-11111111-1111-4111-8111-111111111111-1"],
  } as unknown as NonNullable<typeof task.agentRun>;

  expect(await model.routeConversation(text, task)).toEqual({
    intent: "research",
    query: text.slice(0, 300),
  });
  expect(fetcher).toHaveBeenCalledOnce();

  task.agentRun.outputArtifactIds = [];
  expect(await model.routeConversation(text, task)).toBeNull();
});

it.each(["conversation", "clarification", "draft"])(
  "keeps explicit saved-agent revision executable even when model routes %s",
  async (intent) => {
    const text = "Revise the saved investment memo and keep prior citations.";
    const fetcher = vi.fn<typeof fetch>(async () =>
      result("route_conversation", {
        intent,
        reply: "I can discuss the requested revision.",
      }),
    );
    const model = new ToolCallingModel("fixture-key", "test-model", fetcher);
    const task = freshTask("revision-fallback", "owner");
    task.agentRun = {
      id: "11111111-1111-4111-8111-111111111111",
      goal: "Prepare a cited market memo",
      status: "completed",
      steps: [],
      sources: [],
      outputArtifactIds: ["agent-doc-11111111-1111-4111-8111-111111111111-1"],
    } as unknown as NonNullable<typeof task.agentRun>;

    expect(await model.routeConversation(text, task)).toEqual({
      intent: "research",
      query: text,
    });
  },
);

it("keeps sole-document revision context narrow and the existing source content visible", async () => {
  const task = freshTask("revision-small-context", "owner");
  const original = "Observed market evidence with citations. ".repeat(150);
  task.artifacts.push({
    id: "agent-doc-prior-1",
    kind: "research-report",
    title: "Existing investment memo",
    content: original,
    evidenceIds: [],
    dependencies: [],
    assumptions: [],
    version: 1,
    freshness: "current",
    edited: false,
  });
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const context = JSON.parse(request.input[1].content);

    expect(request.input[0].content).toContain("HARD constraint");
    expect(context.savedArtifacts[0].content.length).toBeGreaterThan(2500);
    expect(context.culturalCandidates).toEqual([]);
    expect(context.culturalEvidence).toEqual([]);
    expect(context.knownEntities).toEqual([]);

    return result("choose_agent_action", {
      name: "document.revise",
      arguments: {
        artifactId: "agent-doc-prior-1",
        title: "Revised memo",
        content:
          "The original evidence remains visible; revisions remain unverified.",
        sourceIds: [],
      },
    });
  });
  const tool = {
    name: "document.revise",
    description: "Revise the existing saved memo",
    permission: "internal" as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        artifactId: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        sourceIds: { type: "array", items: { type: "string" } },
      },
      required: ["artifactId", "title", "content", "sourceIds"],
    },
  };
  const model = new ToolCallingModel("fixture-key", "test-model", fetcher);

  await expect(
    model.chooseAgentAction("Revise the existing memo", [tool], [], task),
  ).resolves.toMatchObject({ name: "document.revise" });
  expect(fetcher).toHaveBeenCalledOnce();
});
