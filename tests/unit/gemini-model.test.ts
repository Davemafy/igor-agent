import { readRecordingText } from "../../src/tools/recording-file";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiModel } from "../../src/tools/gemini-model";
import { freshLiveExample } from "../../src/data/live-task";
import {
  LiveQlooProvider,
  MemoryResponseCache,
} from "../../src/tools/qloo-live";
import { SqliteTaskStore } from "../../src/data/store";
import { runTurn } from "../../src/core/orchestrator";
import type { Task } from "../../src/core/contracts";
import { assertArtifactIntegrity } from "../../src/capabilities/evaluate";
import { runtimeModelProvider } from "../../src/tools/runtime";

const key = "unit-test-private-credential";

const seed = "11111111-1111-4111-8111-111111111111";

const ids = {
  movie: "22222222-2222-4222-8222-222222222222",
  tv_show: "33333333-3333-4333-8333-333333333333",
  artist: "44444444-4444-4444-8444-444444444444",
};

const result = (name: string, args: unknown) =>
  Response.json({
    modelVersion: "gemini-3.5-flash-lite",
    usageMetadata: { totalTokenCount: 403 },
    candidates: [
      {
        finishReason: "STOP",
        content: {
          role: "model",
          parts: [
            {
              functionCall: { name, args, id: "original-call-id" },
              thoughtSignature: "original-signature",
            },
          ],
        },
      },
    ],
  });

const interpretation = {
  supported: true,
  intent: "goal",
  kind: "gathering",
  goal: "A film and music gathering",
  budget: 60,
  duration: 180,
  wording: null,
};

const stores: SqliteTaskStore[] = [];

afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  vi.unstubAllEnvs();
});

function qlooMock() {
  return vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url));

    if (u.pathname === "/search") {
      const name = u.searchParams.get("query");

      return Response.json({
        results: [
          {
            entity_id: seed,
            name,
            subtype: ["Arrival", "Moonlight", "Spirited Away"].includes(
              name ?? "",
            )
              ? "urn:entity:movie"
              : "urn:entity:artist",
          },
        ],
      });
    }

    const type = u.searchParams
      .get("filter.type")!
      .replace("urn:entity:", "") as keyof typeof ids;

    return Response.json({
      results: {
        entities: [
          {
            entity_id: ids[type],
            name: `Mock ${type}`,
            subtype: `urn:entity:${type}`,
            query: { affinity: 0.6 },
          },
        ],
      },
    });
  }) as unknown as ReturnType<typeof vi.fn<typeof fetch>>;
}

async function providerTask() {
  const t = freshLiveExample("t", "o");
  const p = new LiveQlooProvider(key, new MemoryResponseCache(), qlooMock());
  const r = await p.discover({
    participants: t.brief.participants,
    catalogue: [],
    location: "At home",
    version: 0,
    mode: "none",
  });
  t.candidates = r.data.options.map((c) => ({
    ...c,
    eligibility: "needs-review",
    missing: ["cost"],
    violations: [],
    evidenceIds: [],
    dependencies: [],
    freshness: "current",
    fit: {},
    fitReason: "",
  }));

  return t;
}

describe("Gemini backend adapter (mock HTTP; not additional live API calls)", () => {
  it("counts failed cultural requests in receipts even when resolution stops before a normal trace", async () => {
    const store = new SqliteTaskStore(":memory:");
    stores.push(store);
    store.create(freshLiveExample("t", "o"));
    const http = vi.fn(
      async () => new Response("private provider body", { status: 401 }),
    ) as typeof fetch;
    const provider = new LiveQlooProvider(key, new MemoryResponseCache(), http);
    const task = await runTurn(
      store,
      "t",
      "o",
      { type: "sample", version: 0 },
      undefined,
      provider,
    );
    expect(provider.calls).toBe(1);
    expect(task.receipts?.at(-1)?.culturalRequests).toBe(1);
    expect(JSON.stringify(task)).not.toContain("private provider body");
  });
  it("extracts typed conversational actions with bounded context and no owner or credentials in the prompt", async () => {
    const context = freshLiveExample("private-task-id", "private-owner-marker");
    const http = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(JSON.stringify(body)).not.toContain("private-owner-marker");
      expect(JSON.stringify(body)).not.toContain(key);
      expect(JSON.stringify(body)).toContain("Amara");
      expect(
        body.tools[0].functionDeclarations[0].parametersJsonSchema.properties
          .decision,
      ).toBeDefined();

      return result("update_brief", {
        ...interpretation,
        intent: "revision",
        goal: "",
        budget: null,
        duration: null,
        actions: [
          {
            kind: "preference",
            participant: "amara",
            value: "Kendrick Lamar",
            polarity: "like",
            entityType: "artist",
          },
        ],
      });
    }) as typeof fetch;
    const model = new GeminiModel(key, "gemini-3.5-flash-lite", http);
    expect(
      (await model.interpret("Amara likes Kendrick Lamar", context))
        .actions?.[0],
    ).toMatchObject({
      kind: "preference",
      participant: "amara",
      polarity: "like",
    });
  });
  it("rejects the actual 2026-10-24 Gemini correction response with an unsupported choose action", async () => {
    const recorded = JSON.parse(
      readRecordingText("tests/fixtures/conversation-probe-live.json"),
    );
    expect(recorded.error).toBe("invalid_revision_classification");
    const response = recorded.model_records[0].response;
    const http = vi.fn(async () => Response.json(response)) as typeof fetch;
    const model = new GeminiModel(key, "gemini-3.5-flash-lite", http);
    await expect(
      model.interpret("Use Moonlight from 2016.", freshLiveExample("t", "o")),
    ).rejects.toThrow();
    expect(model.calls).toBe(2);
  });
  it("rejects a model attempting to grant itself new actions", async () => {
    const http = vi.fn(async () =>
      result("update_brief", {
        ...interpretation,
        actions: [{ kind: "fetch_url", url: "https://evil.test" }],
      }),
    ) as typeof fetch;
    await expect(
      new GeminiModel(key, "gemini-3.5-flash-lite", http).interpret("x"),
    ).rejects.toThrow();
  });
  it("uses fixed endpoint and server credential, validates interpretation and counts usage", async () => {
    const http = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(_url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
      );
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ "x-goog-api-key": key });

      return result("update_brief", interpretation);
    }) as typeof fetch;
    const model = new GeminiModel(key, "gemini-3.5-flash-lite", http);
    expect(await model.interpret("Plan a gathering")).toMatchObject({
      kind: "gathering",
      budget: 60,
      duration: 180,
    });
    expect(model.calls).toBe(1);
    expect(model.usage[0].total).toBe(403);
  });
  it("round-trips exact function IDs and thought signatures; baseline receives no cultural fields", async () => {
    const bodies: Record<string, unknown>[] = [];
    const http = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const tool = body.tools[0].functionDeclarations[0].name;

      return result(
        tool,
        tool === "inspect_candidates" ? {} : { ids: [ids.movie] },
      );
    }) as typeof fetch;
    const model = new GeminiModel(key, "gemini-3.5-flash-lite", http);
    const task = await providerTask();
    expect(await model.recommend(task, false)).toEqual([ids.movie]);
    expect(await model.recommend(task, true)).toEqual([ids.movie]);
    const contexts = [bodies[1], bodies[3]].map((b) => {
      const contents = b.contents as {
        role: string;
        parts: {
          functionResponse?: { id: string; response: { result: unknown } };
          thoughtSignature?: string;
        }[];
      }[];
      expect(contents[1].parts[0].thoughtSignature).toBe("original-signature");
      expect(contents[2].parts[0].functionResponse?.id).toBe(
        "original-call-id",
      );

      return contents[2].parts[0].functionResponse!.response.result;
    }) as {
      profiles: unknown;
      candidates: { id: string; cultural?: unknown }[];
    }[];
    expect(contexts[0].profiles).toEqual(contexts[1].profiles);
    expect(contexts[0].candidates.map((c) => c.id)).toEqual(
      contexts[1].candidates.map((c) => c.id),
    );
    expect(JSON.stringify(contexts[0])).not.toMatch(
      /affinity|queryId|explanationEntities|cultural/,
    );
    expect(JSON.stringify(contexts[1])).toContain("affinity");
    expect(model.calls).toBe(4);
  });
  it.each([401, 403, 404, 429, 503])(
    "rejects HTTP %s without retry or leaked response body",
    async (status) => {
      const http = vi.fn(
        async () => new Response(key + " provider internal", { status }),
      ) as typeof fetch;
      await expect(
        new GeminiModel(key, "gemini-3.5-flash-lite", http).interpret("x"),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(http).toHaveBeenCalledTimes(1);
    },
  );
  it("enforces model name, request and payload budgets before transport", async () => {
    const http = vi.fn(async () =>
      result("update_brief", interpretation),
    ) as typeof fetch;
    await expect(
      new GeminiModel(key, "../../secret", http).interpret("x"),
    ).rejects.toThrow("configured safely");
    await expect(
      new GeminiModel(key, "gemini-test", http).interpret("x".repeat(210000)),
    ).rejects.toThrow("input size budget");
    expect(http).not.toHaveBeenCalled();
    const m = new GeminiModel(key, "gemini-test", http, 1);
    await m.interpret("x");
    await expect(m.interpret("y")).rejects.toThrow("request budget");
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("rejects missing, malformed, truncated and unauthorized outputs", async () => {
    const outputs = [
      Response.json({}),
      result("fetch_url", {}),
      Response.json({ candidates: [{ finishReason: "MAX_TOKENS" }] }),
      result("update_brief", { ...interpretation, budget: -1 }),
    ];

    for (const response of outputs) {
      await expect(
        new GeminiModel(
          key,
          "gemini-test",
          vi.fn(async () => response) as typeof fetch,
        ).interpret("x"),
      ).rejects.toThrow();
    }
  });
  it("rejects response credential echoes, oversized responses and transport timeouts", async () => {
    for (const text of [
      JSON.stringify({ credential: key }),
      "x".repeat(100001),
    ]) {
      await expect(
        new GeminiModel(
          key,
          "gemini-test",
          vi.fn(async () => new Response(text)) as typeof fetch,
        ).interpret("x"),
      ).rejects.toThrow(/Unsafe|Oversized/);
    }

    await expect(
      new GeminiModel(
        key,
        "gemini-test",
        vi.fn(async () => {
          throw new Error(key);
        }) as typeof fetch,
      ).interpret("x"),
    ).rejects.toThrow("timed out safely");
  });
  it("rejects invented selections and duplicate IDs", async () => {
    for (const selected of [["invented"], [ids.movie, ids.movie]]) {
      let n = 0;
      const http = vi.fn(async () =>
        n++ === 0
          ? result("inspect_candidates", {})
          : result("submit_selection", { ids: selected }),
      ) as typeof fetch;
      await expect(
        new GeminiModel(key, "gemini-test", http).recommend(
          await providerTask(),
          true,
        ),
      ).rejects.toThrow("outside Qloo");
    }
  });
  it("runtime chooses Gemini when configured and does not put keys in task state", () => {
    vi.stubEnv("GEMINI_API_KEY", key);
    vi.stubEnv("GEMINI_MODEL", "gemini-3.5-flash-lite");
    expect(runtimeModelProvider("qloo-live")).toBeInstanceOf(GeminiModel);
    const task = freshLiveExample("t", "o");
    expect(task.modelMode).toBe("tool-calling");
    expect(JSON.stringify(task)).not.toContain(key);
  });
  it("runs goal → unknown facts → supplied facts → programme → corrections → baseline without model-controlled feasibility", async () => {
    const store = new SqliteTaskStore(":memory:");
    stores.push(store);
    store.create(freshLiveExample("t", "o"));
    const cache = new MemoryResponseCache();
    const qloo = qlooMock();
    const provider = () => new LiveQlooProvider(key, cache, qloo);
    const modelHttp = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body));
      const name = b.tools[0].functionDeclarations[0].name;

      return result(
        name,
        name === "route_conversation"
          ? { intent: "delegate" }
          : name === "update_brief"
            ? interpretation
            : name === "inspect_candidates"
              ? {}
              : { ids: [ids.movie] },
      );
    }) as typeof fetch;
    const model = new GeminiModel(key, "gemini-3.5-flash-lite", modelHttp);
    let task = await runTurn(
      store,
      "t",
      "o",
      { type: "message", text: "A three-hour gathering for $60", version: 0 },
      undefined,
      provider(),
      model,
    );
    expect(task.modelMode).toBe("tool-calling");
    expect(task.status).toBe("partial");
    expect(task.receipts?.at(-1)?.modelRequests).toBe(2);
    expect(task.receipts?.at(-1)?.culturalRequests).toBe(
      qloo.mock.calls.length,
    );
    expect(task.candidates.every((c) => c.eligibility === "needs-review")).toBe(
      true,
    );
    const options = task.catalogue.map((c) => ({
      ...c,
      cost: {
        ...c.cost,
        value: 5,
        reference: "Operator-supplied planning assumption",
      },
      duration: {
        ...c.duration,
        value: c.type === "artist" ? 15 : 60,
        reference: "Operator-supplied planning minutes",
      },
      available: true,
    }));
    task = await runTurn(
      store,
      "t",
      "o",
      { type: "catalogue", options, version: task.brief.version },
      undefined,
      provider(),
      model,
    );
    expect(task.status).toBe("ready");
    expect(task.artifacts.some((a) => a.id === "invitation")).toBe(true);
    expect(task.brief.selected.length).toBeGreaterThan(0);
    expect(() => assertArtifactIntegrity(task)).not.toThrow();
    const qlooBefore = qloo.mock.calls.length;
    const modelBefore = model.calls;
    task = await runTurn(
      store,
      "t",
      "o",
      {
        type: "artifact",
        artifactId: "invitation",
        content: "Bring a friend and your perspective.",
        version: task.brief.version,
      },
      undefined,
      provider(),
      model,
    );
    expect(qloo.mock.calls.length).toBe(qlooBefore);
    expect(model.calls).toBe(modelBefore);
    task = await runTurn(
      store,
      "t",
      "o",
      { type: "constraints", budget: 1, version: task.brief.version },
      undefined,
      provider(),
      model,
    );
    expect(task.brief.selected).toEqual([]);
    expect(qloo.mock.calls.length).toBe(qlooBefore);
    const observed: Task[] = [];
    const participant = structuredClone(task.brief.participants[0]);
    participant.preferences[0].value = "Björk";
    const otherEvidence = task.evidence.find(
      (e) =>
        e.dependencies.includes("preferences:leo") &&
        !e.dependencies.includes("preferences:amara"),
    );
    expect(otherEvidence).toBeDefined();
    task = await runTurn(
      store,
      "t",
      "o",
      { type: "participant", participant, version: task.brief.version },
      (e) => {
        if (e.type === "state" && e.task) {
          observed.push(e.task);
        }
      },
      provider(),
      model,
    );
    expect(observed[0].artifacts.every((a) => a.freshness === "stale")).toBe(
      true,
    );
    expect(
      observed[0].evidence.find((e) => e.id === otherEvidence!.id)?.freshness,
    ).toBe("current");
    expect(task.candidates.every((c) => Object.keys(c.fit).length === 6)).toBe(
      true,
    );
    expect(qloo.mock.calls.length - qlooBefore).toBe(1); // Seed changes, unchanged query seed ID in this mocked response hits cache.
    task = await runTurn(
      store,
      "t",
      "o",
      { type: "baseline", version: task.brief.version },
      undefined,
      provider(),
      model,
    );
    expect(task.evaluation?.status).toBe("ok");
    expect(task.evaluation?.model).toBe("gemini-3.5-flash-lite");
    expect(model.calls).toBe(6);
    expect(qloo.mock.calls.length - qlooBefore).toBe(1);
  });
});

it("lets a valid post-discovery composition decision outlast 15 seconds within Gemini's configured deadline", async () => {
  vi.useFakeTimers();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("Timed out", "TimeoutError")),
        milliseconds,
      );

      return controller.signal;
    });
  const actions = [
    {
      kind: "document",
      id: "brief",
      title: "Brief",
      content: "x".repeat(11000),
      dependencies: [],
      evidenceIds: [],
    },
  ];
  const transport = vi.fn(
    async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve(
              result("choose_agent_action", {
                name: "experience.compose",
                arguments: { actions },
              }),
            ),
          16000,
        );
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("transport timeout"));
          },
          { once: true },
        );
      }),
  );

  try {
    const task = freshLiveExample("deadline", "owner");
    const model = new GeminiModel(key, "gemini-3.5-flash-lite", transport);
    const pending = model.chooseAgentAction(
      "Compose from saved discovery",
      [
        {
          name: "experience.compose",
          permission: "internal",
          description: "Save linked work",
          inputSchema: { type: "object" },
        },
      ],
      [
        {
          tool: "qloo.discover",
          status: "ok",
          summary: "Real query observation saved",
        },
      ],
      task,
    );
    const expected = expect(pending).resolves.toMatchObject({
      name: "experience.compose",
      arguments: { actions },
    });
    await vi.advanceTimersByTimeAsync(16001);
    await expected;
    expect(model.calls).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});
