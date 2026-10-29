import { afterEach, expect, it, vi } from "vitest";
import { freshTask } from "../../src/data/fixtures";
import { applyWorkActions } from "../../src/core/connected-work";
import {
  readArtifactView,
  rememberArtifactView,
  visibleArtifactContext,
} from "../../src/components/artifact-focus";

afterEach(() => vi.unstubAllGlobals());

function context() {
  const task = freshTask("view", "owner");
  applyWorkActions(task, [
    { kind: "goal", id: "gathering", title: "Gathering" },
    {
      kind: "document",
      id: "plan",
      title: "Plan",
      content: "Provisional",
      dependencies: [],
      evidenceIds: [],
    },
  ]);

  return task;
}

it("restores view metadata only for an extant artifact and the same active goal", () => {
  const task = context();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  rememberArtifactView(task, "document:plan");
  expect(readArtifactView(task)).toBe("document:plan");
  expect(task.conversationFocus?.activeArtifactId).not.toBe("document:plan");
  task.work!.activeGoalId = "new-goal";
  expect(readArtifactView(task)).toBeNull();
  task.work!.activeGoalId = "gathering";
  task.work!.documents = [];
  expect(readArtifactView(task)).toBeNull();
});
it("uses the current tab's owned visible artifact, rejecting foreign or stale DOM IDs", () => {
  const task = context();
  const node = (workspace: string, artifact: string) => ({
    getAttribute: (key: string) =>
      key === "data-workspace-id" ? workspace : artifact,
  });
  vi.stubGlobal("document", {
    querySelectorAll: () => [
      node("other", "document:plan"),
      node(task.id, "document:missing"),
      node(task.id, "document:plan"),
    ],
  });
  expect(visibleArtifactContext(task)).toEqual({ artifactId: "document:plan" });
  vi.stubGlobal("document", {
    querySelectorAll: () => [node("other", "document:plan")],
  });
  expect(visibleArtifactContext(task)).toBeUndefined();
});
it("remains usable when browser storage is disabled", () => {
  const task = context();
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  });
  expect(() => rememberArtifactView(task, "document:plan")).not.toThrow();
  expect(readArtifactView(task)).toBeNull();
});
