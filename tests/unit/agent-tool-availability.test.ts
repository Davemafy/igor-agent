import { expect, it, vi } from "vitest";
import { createAgentToolRegistry } from "../../src/core/agent-tool-registry";
import { freshTask } from "../../src/data/fixtures";

const availability = (task: ReturnType<typeof freshTask>) => {
  const tools = createAgentToolRegistry({
    task,
    sources: [],
    runId: "run-tools",
    research: { available: false, research: vi.fn() },
  });

  return Object.fromEntries(tools.map((tool) => [tool.name, tool.available]));
};

it("does not offer revision or redundant inspection before work exists", () => {
  const task = freshTask("first-request", "owner");
  const tools = availability(task);

  expect(tools["document.create"]).toBe(true);
  expect(tools["document.revise"]).toBe(false);
  expect(tools["task.inspect"]).toBe(false);
  expect(tools["experience.compose"]).toBe(false);
  expect(tools["web.search"]).toBe(false);
});

it("offers only state-appropriate edits once an agent document exists", () => {
  const task = freshTask("follow-up", "owner");
  task.artifacts.push({
    id: "agent-doc-existing",
    title: "Existing draft",
    kind: "research-report",
    content: "A saved document that can be revised.",
    dependencies: [],
    evidenceIds: [],
    assumptions: [],
    version: 1,
    freshness: "current",
    edited: false,
  });

  expect(availability(task)["task.inspect"]).toBe(true);
  expect(availability(task)["document.revise"]).toBe(true);

  task.artifacts[0].edited = true;
  expect(availability(task)["document.revise"]).toBe(false);

  task.artifacts[0].edited = false;
  task.artifacts[0].locked = true;
  expect(availability(task)["document.revise"]).toBe(false);
});
