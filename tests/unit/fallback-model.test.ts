import { expect, it, vi } from "vitest";
import { FallbackModel } from "../../src/tools/fallback-model";
import { runtimeModelProvider } from "../../src/tools/runtime";
import { ResponsiveGeminiModel } from "../../src/tools/responsive-gemini";
import { ProviderHttpError } from "../../src/core/interpretation-failure";
import { LiveDecisionSchema } from "../../src/core/contracts";
import { freshTask } from "../../src/data/fixtures";
import { completedTurnAfter } from "../../src/components/workspace-api";

const reply = LiveDecisionSchema.parse({
  intent: "conversation",
  reply: "Hello",
});
it("uses a single configured backup for a transient interpretation failure", async () => {
  const primary = {
    interpret: vi.fn(async () => {
      throw new ProviderHttpError("Gemini", 503, "");
    }),
    calls: 1,
    timeoutMs: 80,
  };
  const backup = {
    interpret: vi.fn(async () => reply),
    calls: 1,
    timeoutMs: 20,
  };
  const model = new FallbackModel(primary, backup);
  expect(await model.interpret("hey")).toEqual(reply);
  expect(backup.interpret).toHaveBeenCalledOnce();
  expect(model.calls).toBe(2);
  expect(model.timeoutMs).toBeGreaterThan(100);
});
it("records a credential failure and never calls a backup after primary success", async () => {
  const backup = { interpret: vi.fn(async () => reply) };
  const model = new FallbackModel(
    {
      interpret: async () => {
        throw new ProviderHttpError("Gemini", 401, "");
      },
    },
    backup,
  );
  expect(await model.interpret("hey")).toEqual(reply);
  expect(model.failures).toEqual([
    { provider: "Gemini", status: 401, category: null },
  ]);
  expect(backup.interpret).toHaveBeenCalledOnce();
  backup.interpret.mockClear();
  expect(
    await new FallbackModel({ interpret: async () => reply }, backup).interpret(
      "hey",
    ),
  ).toEqual(reply);
  expect(backup.interpret).not.toHaveBeenCalled();
});
it("does not keep retry available for an already completed saved turn", () => {
  const task = freshTask("reconnect", "owner");
  task.messages = [];
  task.brief.version = 2;
  task.status = "ready";
  expect(completedTurnAfter(task, 1, 0)).toBe(false);
  task.messages.push({
    role: "assistant",
    text: "Saved result",
    at: new Date().toISOString(),
  });
  expect(completedTurnAfter(task, 1, 0)).toBe(true);
  expect(completedTurnAfter(task, 2, 0)).toBe(false);
  task.status = "error";
  expect(completedTurnAfter(task, 1, 0)).toBe(false);
});

it.each(["draft", "clarification"] as const)(
  "recognises a saved %s reply after a dropped connection without replaying it",
  (status) => {
    const task = freshTask("reconnect-intake", "owner");
    task.status = status;
    task.brief.version = 2;
    task.messages = [
      {
        role: "assistant",
        text: "Earlier reply",
        at: new Date().toISOString(),
      },
    ];
    expect(completedTurnAfter(task, 1, 1)).toBe(false);
    task.messages.push({
      role: "assistant",
      text: "New reply",
      at: new Date().toISOString(),
    });
    expect(completedTurnAfter(task, 1, 1)).toBe(true);
    expect(completedTurnAfter(task, 2, 1)).toBe(false);
    task.status = "running";
    expect(completedTurnAfter(task, 1, 1)).toBe(false);
  },
);

it("falls back only for schema-related HTTP 400, never unrelated bad requests", async () => {
  const primary = {
    interpret: vi.fn(async () => {
      throw new ProviderHttpError(
        "Gemini",
        400,
        "Unsupported parametersJsonSchema required properties",
      );
    }),
  };
  const backup = {
    interpret: vi.fn(async () => reply),
  };
  await expect(
    new FallbackModel(primary, backup).interpret("dining, monopoly"),
  ).resolves.toEqual(reply);
  expect(backup.interpret).toHaveBeenCalledOnce();

  backup.interpret.mockClear();
  await expect(
    new FallbackModel(
      {
        async interpret() {
          throw new ProviderHttpError("Gemini", 400, "unrelated bad request");
        },
      },
      backup,
    ).interpret("dining, monopoly"),
  ).rejects.toThrow("400");
  expect(backup.interpret).not.toHaveBeenCalled();
});

it("keeps subsequent work on the healthy backup after a routing failure", async () => {
  const primary = {
    routeConversation: vi.fn(async () => {
      throw new ProviderHttpError("Grok", 503, "");
    }),
    interpret: vi.fn(async () => reply),
    composeDraft: vi.fn(async () => ({
      title: "Wrong provider",
      content: "Wrong",
    })),
  };
  const backup = {
    routeConversation: vi.fn(async () => ({ intent: "draft" as const })),
    interpret: vi.fn(async () => reply),
    composeDraft: vi.fn(async () => ({
      title: "A first draft",
      content: "Actual proposed work",
    })),
  };
  const model = new FallbackModel(primary, backup);
  expect(await model.routeConversation("Make a concept")).toEqual({
    intent: "draft",
  });
  expect(
    await model.composeDraft(
      "Make a concept",
      freshTask("fallback-draft", "owner"),
    ),
  ).toMatchObject({ title: "A first draft" });
  expect(primary.composeDraft).not.toHaveBeenCalled();
  expect(backup.composeDraft).toHaveBeenCalledOnce();
});
it("does not invoke an absent-primary synthesis backup twice", async () => {
  const backup = {
    interpret: async () => reply,
    synthesizeResearch: vi.fn(async () => {
      throw new ProviderHttpError("Claude", 503, "");
    }),
  };
  await expect(
    new FallbackModel(
      { interpret: async () => reply },
      backup,
    ).synthesizeResearch("question", [], freshTask("synthesis", "owner")),
  ).rejects.toThrow("503");
  expect(backup.synthesizeResearch).toHaveBeenCalledOnce();
});

it("uses a separately configured backup for the observed Grok credential rejection", async () => {
  const primary = {
    interpret: vi.fn(async () => {
      throw new ProviderHttpError("Grok", 400, "Incorrect API key supplied");
    }),
  };
  const backup = { interpret: vi.fn(async () => reply) };
  const model = new FallbackModel(primary, backup);
  expect(await model.interpret("Hello")).toEqual(reply);
  expect(model.failures).toContainEqual({
    provider: "Grok",
    status: 400,
    category: "credentials",
  });
  expect(await model.interpret("Continue")).toEqual(reply);
  expect(primary.interpret).toHaveBeenCalledOnce();
  expect(backup.interpret).toHaveBeenCalledTimes(2);
});

it("uses a third authorized model when the first two independently fail", async () => {
  const first = {
    interpret: vi.fn(async () => {
      throw new ProviderHttpError("Gemini", 503, "");
    }),
  };
  const second = {
    interpret: vi.fn(async () => {
      throw new ProviderHttpError("Grok", 400, "Incorrect API key supplied");
    }),
  };
  const third = { interpret: vi.fn(async () => reply) };
  const model = new FallbackModel(first, new FallbackModel(second, third));

  expect(await model.interpret("Plan an experience")).toEqual(reply);
  expect(first.interpret).toHaveBeenCalledOnce();
  expect(second.interpret).toHaveBeenCalledOnce();
  expect(third.interpret).toHaveBeenCalledOnce();
  expect(await model.interpret("Continue the existing work")).toEqual(reply);
  expect(first.interpret).toHaveBeenCalledOnce();
  expect(second.interpret).toHaveBeenCalledOnce();
  expect(third.interpret).toHaveBeenCalledTimes(2);
});

it("prefers the explicitly enabled alternate Gemini model before unverified Grok", () => {
  const keys = [
    "GEMINI_API_KEY",
    "GEMINI_MODEL",
    "GEMINI_FALLBACK_MODEL",
    "IGOR_MODEL_PROVIDER",
    "GROK_API_KEY",
    "XAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "LLM_API_KEY",
    "LLM_MODEL",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  try {
    process.env.GEMINI_API_KEY = "unit-only-key";
    process.env.GEMINI_MODEL = "gemini-3.1-flash-lite";
    process.env.GEMINI_FALLBACK_MODEL = "gemini-3.5-flash-lite";
    process.env.IGOR_MODEL_PROVIDER = "gemini";
    process.env.GROK_API_KEY = "unit-only-grok-key";
    delete process.env.XAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;

    const model = runtimeModelProvider("qloo-live");
    expect(model).toBeInstanceOf(FallbackModel);
    const first = model as unknown as {
      primary: ResponsiveGeminiModel;
      backup: FallbackModel;
    };
    expect(first.primary).toBeInstanceOf(ResponsiveGeminiModel);
    expect(first.backup).toBeInstanceOf(FallbackModel);
    const second = first.backup as unknown as {
      primary: ResponsiveGeminiModel;
    };
    expect(second.primary).toBeInstanceOf(ResponsiveGeminiModel);
    expect(
      (first.primary as unknown as { model: string }).model,
    ).toBe("gemini-3.1-flash-lite");
    expect(
      (second.primary as unknown as { model: string }).model,
    ).toBe("gemini-3.5-flash-lite");
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
