import { expect, it, vi } from "vitest";
import { createAgentToolRegistry } from "../../src/core/agent-tool-registry";
import { freshTask } from "../../src/data/fixtures";

it("normalizes benign document shapes but never manufactures citations", () => {
  const tools = createAgentToolRegistry({
    task: freshTask("document-shapes", "owner"),
    runId: "run-docs",
    sources: [],
    research: { available: false, research: vi.fn() },
  });
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
  const parsed = document?.schema.parse(input) as {
    content: string;
    title: string;
    sourceIds: string[];
    evidenceIds: string[];
    extraPrivilegedAction?: string;
  };

  expect(parsed.content).toContain("\n\n");
  expect(parsed.sourceIds).toEqual([]);
  expect(parsed.evidenceIds).toEqual([]);
  expect(parsed.extraPrivilegedAction).toBeUndefined();
  expect(() => document?.schema.parse({ content: input.content })).toThrow();
});
