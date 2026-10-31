import { describe, expect, it, vi } from "vitest";
import { applyWorkActions } from "../../src/core/connected-work";
import { createAgentToolRegistry } from "../../src/core/agent-tool-registry";
import { freshTask } from "../../src/data/fixtures";

function seeded() {
  const task = freshTask("connected-edit", "owner");
  applyWorkActions(task, [
    { kind: "goal", id: "gallery-evening", title: "Gallery evening" },
    {
      kind: "document",
      id: "gallery-invitation",
      title: "Invitation",
      content: "Original invitation with unchanged evidence.",
      dependencies: [],
      evidenceIds: [],
    },
    {
      kind: "document",
      id: "gallery-schedule",
      title: "Schedule",
      content: "Original schedule; preserve this separately.",
      dependencies: [],
      evidenceIds: [],
    },
  ]);
  const context = {
    task,
    runId: "revision-run",
    sources: [],
    research: { available: false, research: vi.fn() },
  };
  const revise = createAgentToolRegistry(context).find(
    (tool) => tool.name === "document.revise",
  );

  return { task, context, revise };
}

describe("connected work agent revision boundary", () => {
  it("revises only the selected connected document and retains version history", async () => {
    const { task, context, revise } = seeded();
    const unrelated = structuredClone(task.work?.documents[1]);

    expect(revise?.available).toBe(true);
    const result = await revise?.execute(
      {
        artifactId: "document:gallery-invitation",
        title: "Revised invitation",
        content: "Revised invitation for Friday, retaining original evidence.",
        sourceIds: [],
      },
      context,
    );

    expect(result?.status).toBe("ok");
    expect(result?.artifactIds).toEqual(["document:gallery-invitation"]);
    const updated = task.work?.documents.find(
      (document) => document.id === "gallery-invitation",
    );
    expect(updated?.version).toBe(2);
    expect(updated?.content).toContain("Revised invitation");
    expect(updated?.history.at(-1)?.content).toContain("Original invitation");
    expect(task.work?.documents[1]).toEqual(unrelated);
  });

  it("preserves approved wording and refuses unsupported citations", async () => {
    const { task, context, revise } = seeded();
    const before = structuredClone(task.work);
    const invalid = await revise?.execute(
      {
        artifactId: "document:gallery-invitation",
        title: "Unsupported revision",
        content: "The citation provided here has never been retrieved.",
        sourceIds: ["web-999"],
      },
      context,
    );
    expect(invalid?.status).toBe("blocked");
    expect(task.work).toEqual(before);

    applyWorkActions(task, [{ kind: "approve", id: "gallery-invitation" }]);
    const protectedWork = structuredClone(task.work);
    const blocked = await revise?.execute(
      {
        artifactId: "document:gallery-invitation",
        title: "Attempted overwrite",
        content: "This must never overwrite approved wording.",
        sourceIds: [],
      },
      context,
    );
    expect(blocked?.status).toBe("blocked");
    expect(task.work).toEqual(protectedWork);
  });
});
