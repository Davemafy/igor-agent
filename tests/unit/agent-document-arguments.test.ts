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
