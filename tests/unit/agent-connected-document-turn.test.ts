import { describe, expect, it, vi } from "vitest";
import { runUnifiedAgent } from "../../src/core/unified-agent";
import { applyWorkActions } from "../../src/core/connected-work";
import { freshTask } from "../../src/data/fixtures";
import { SqliteTaskStore } from "../../src/data/store";

describe("agent multi-turn connected document editing", () => {
  it("revises the existing document, then allows finish without rewriting other work", async () => {
    const store = new SqliteTaskStore(":memory:");
    const task = freshTask("connected-agent-turn", "owner");
    applyWorkActions(task, [
      { kind: "goal", id: "event-evening", title: "An evening together" },
      {
        kind: "document",
        id: "invitation",
        title: "Original invitation",
        content: "A warm invitation for friends.",
        evidenceIds: [],
        dependencies: [],
      },
      {
        kind: "document",
        id: "schedule",
        title: "Existing schedule",
        content: "Plan remains unchanged.",
        evidenceIds: [],
        dependencies: [],
      },
    ]);
    store.create(task);
    const schedule = structuredClone(task.work?.documents[1]);
    const offered: string[][] = [];

    try {
      const result = await runUnifiedAgent({
        task,
        store,
        owner: "owner",
        goal: "Revise the saved invitation with a warmer tone. Keep the schedule unchanged.",
        model: {
          async interpret() {
            throw Error("Not used");
          },
          async interpretAgentRequirements() {
            return {
              culturalDecision: false,
              culturalReferences: [],
              deliverables: [],
            };
          },
          async chooseAgentAction(_goal, tools) {
            offered.push(tools.map((tool) => tool.name));

            if (offered.length === 1) {
              return {
                name: "document.revise",
                arguments: {
                  artifactId: "document:invitation",
                  title: "Warm invitation",
                  content:
                    "We would love to see you at the evening gathering. Please join us and bring your good energy.",
                  sourceIds: [],
                },
              };
            }

            return { name: "agent.finish", arguments: {} };
          },
        },
        research: { available: false, research: vi.fn() },
        trace: vi.fn(),
      });

      expect(offered[0]).toEqual(["document.revise"]);
      expect(offered[1]).toContain("agent.finish");
      expect(task.work?.documents.find((d) => d.id === "invitation")).toMatchObject({
        title: "Warm invitation",
        version: 2,
      });
      expect(task.work?.documents[1]).toEqual(schedule);
      expect(result.status).toBe("ok");
      expect(store.load(task.id, "owner").work).toEqual(task.work);
    } finally {
      store.close();
    }
  });
});
