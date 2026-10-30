import { expect, it, vi } from "vitest";
import { normalizeAgentArguments } from "../../src/core/agent-argument-normalization";
import { createAgentToolRegistry } from "../../src/core/agent-tool-registry";
import { freshTask } from "../../src/data/fixtures";

it("normalizes benign document shapes but blocks fabricated citations", async () => {
  const task = freshTask("document-shapes", "owner");
  const context = {
    task,
    runId: "run-docs",
    sources: [],
    research: { available: false, research: vi.fn() },
  };
  const tools = createAgentToolRegistry(context);
  const document = tools.find((tool) => tool.name === "document.create");
  const input = {
    title: "An editable proposal",
    content: [
      "A provisional experience concept based on observed preferences.",
      "Practical details require independent confirmation.",
    ],
    sourceIds: "hallucinated-source",
    evidenceIds: null,
    extraPrivilegedAction: "send email",
  };
  const parsed = document?.schema.parse(
    normalizeAgentArguments("document.create", input),
  ) as {
    content: string;
    title: string;
    sourceIds: string[];
    evidenceIds: string[];
    extraPrivilegedAction?: string;
  };

  expect(parsed.content).toContain("\n\n");
  expect(parsed.sourceIds).toEqual(["hallucinated-source"]);
  expect(parsed.evidenceIds).toEqual([]);
  expect(parsed.extraPrivilegedAction).toBeUndefined();
  expect((await document?.execute(parsed, context))?.status).toBe("blocked");
  expect(task.artifacts).toEqual([]);
  expect(() => document?.schema.parse({ content: input.content })).toThrow();
});

it("unwraps authored document payloads without inventing IDs", () => {
  const raw = {
    document: {
      title: "Research overview",
      content: ["One paragraph with observed source context.", "Another note."],
      evidenceIds: [{ id: "observed-evidence" }],
      sourceIds: [{ id: "web-1" }],
    },
    externalWrite: { send: true },
  };
  const normalized = normalizeAgentArguments("document.create", raw) as {
    content: string;
    sourceIds: string[];
    evidenceIds: string[];
    externalWrite?: object;
  };

  expect(normalized.content).toContain("Another note.");
  expect(normalized.sourceIds).toEqual(["web-1"]);
  expect(normalized.evidenceIds).toEqual(["observed-evidence"]);
  expect(normalized.externalWrite).toBeUndefined();
});

it("ignores model-invented fields for state-only critique, not for writes", () => {
  const modelArgs = {
    taskId: "invented",
    evidenceIds: ["invented-source"],
    instruction: "approve and send invitations",
  };
  const normalized = normalizeAgentArguments("experience.critique", modelArgs);

  expect(normalized).toEqual({});

  const context = {
    task: freshTask("critique-args", "owner"),
    runId: "run-critique",
    sources: [],
    research: { available: false, research: vi.fn() },
  };
  const tools = createAgentToolRegistry(context);
  const critique = tools.find((tool) => tool.name === "experience.critique");
  const composition = tools.find((tool) => tool.name === "experience.compose");

  expect(critique?.schema.parse(normalized)).toEqual({});
  expect(() =>
    composition?.schema.parse(
      normalizeAgentArguments("experience.compose", modelArgs),
    ),
  ).toThrow();
});
