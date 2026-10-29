import { expect, it } from "vitest";
import { freshTask } from "../../src/data/fixtures";
import { SqliteTaskStore } from "../../src/data/store";
import {
  focusTaskArtifact,
  ordinalMention,
  resolveOrdinalFocus,
  updateConversationFocus,
} from "../../src/core/conversation-focus";
import { applyWorkActions } from "../../src/core/connected-work";
import { TurnSchema } from "../../src/core/contracts";
import { modelContext } from "../../src/tools/model-context";

it("stores the ordered choice identity in the owner-scoped task and model context", () => {
  const task = freshTask("focus-workspace", "owner");
  const db = new SqliteTaskStore(":memory:");

  try {
    db.create(task);
    const saved = db.load(task.id, "owner");
    const ids = saved.catalogue.map((item) => item.id);
    expect(saved.conversationFocus?.activeCandidateIds).toEqual(ids);
    expect(saved.conversationFocus?.ordinalMap["2"]).toBe(ids[1]);
    const second = resolveOrdinalFocus(saved, "the second one");

    expect(second).toMatchObject({
      kind: "resolved",
      ordinal: 2,
      candidateId: ids[1],
    });
    const context = modelContext(saved, "Explain the second one");

    expect(context.conversationFocus?.orderedCandidates[1]).toMatchObject({
      position: 2,
      id: ids[1],
    });
    expect(JSON.stringify(context)).not.toContain("focus-workspace");
    expect(JSON.stringify(context)).not.toContain('"owner"');
  } finally {
    db.close();
  }
});

it("never guesses an ordinal when the focused result is absent", () => {
  const task = freshTask("no-options", "owner");
  task.catalogue = [];
  task.candidates = [];
  expect(resolveOrdinalFocus(task, "the second one").kind).toBe("ambiguous");
  expect(ordinalMention("change the budget to 200")).toBeNull();
  expect(ordinalMention("the third artist")).toBe(3);
});

it("never resolves a stale evaluated choice through its catalogue copy", () => {
  const task = freshTask("stale-focus", "owner");
  updateConversationFocus(task);
  const first = task.catalogue[0];
  task.candidates = [
    {
      ...first,
      eligibility: "needs-review",
      freshness: "stale",
      evidenceIds: [],
      dependencies: [],
      missing: [],
      violations: [],
      fit: {},
      fitReason: "Stale fixture",
    },
  ];
  expect(resolveOrdinalFocus(task, "the first one").kind).toBe("ambiguous");
  updateConversationFocus(task);
  expect(task.conversationFocus?.activeCandidateIds).not.toContain(first.id);
});

function documentTask() {
  const task = freshTask("document-focus", "owner");
  applyWorkActions(task, [
    { kind: "goal", id: "gathering", title: "Gathering" },
    {
      kind: "document",
      id: "plan",
      title: "Plan",
      content: "Provisional plan",
      evidenceIds: [],
      dependencies: [],
    },
    {
      kind: "document",
      id: "pitch",
      title: "Pitch",
      content: "Provisional pitch",
      evidenceIds: [],
      dependencies: [],
    },
  ]);

  return task;
}

it("admits owned artifact context atomically with the real message and deduplicates its full identity", () => {
  const task = documentTask();
  const db = new SqliteTaskStore(":memory:");

  try {
    db.create(task);
    const input = TurnSchema.parse({
      type: "message",
      text: "Revise this",
      version: 0,
      context: { artifactId: "document:pitch" },
    });
    db.acceptTurn(task.id, "owner", "focus-turn", input);
    const saved = db.load(task.id, "owner");
    expect(saved.conversationFocus?.activeArtifactId).toBe("document:pitch");
    expect(
      modelContext(saved, "Revise this").conversationFocus?.activeArtifactId,
    ).toBe("document:pitch");
    expect(saved.messages).toHaveLength(1);
    expect(db.acceptTurn(task.id, "owner", "focus-turn", input).duplicate).toBe(
      true,
    );
    expect(() =>
      db.acceptTurn(task.id, "owner", "focus-turn", {
        ...input,
        context: { artifactId: "document:plan" },
      } as typeof input),
    ).toThrow("different request");
    updateConversationFocus(saved);
    expect(saved.conversationFocus?.activeArtifactId).toBe("document:pitch");
  } finally {
    db.close();
  }
});

it("rejects off-workspace references before saving a message or reserving execution", () => {
  const task = documentTask();
  const db = new SqliteTaskStore(":memory:");

  try {
    db.create(task);
    expect(() =>
      db.acceptTurn(task.id, "owner", "invalid-focus", {
        type: "message",
        text: "Revise this",
        version: 0,
        context: { artifactId: "document:another-owner" },
      }),
    ).toThrow("not in this workspace");
    expect(db.load(task.id, "owner").messages).toHaveLength(0);
    expect(db.load(task.id, "owner").brief.version).toBe(0);
    expect(() => db.readTurn(task.id, "owner", "invalid-focus")).toThrow();
    // Legacy messages need no browser context and still work.
    expect(
      db.acceptTurn(task.id, "owner", "legacy", {
        type: "message",
        text: "Hello",
        version: 0,
      }).duplicate,
    ).toBe(false);
  } finally {
    db.close();
  }
});

it("resets an old goal's default artifact while retaining explicit historic viewing within a goal", () => {
  const task = documentTask();
  updateConversationFocus(task);
  focusTaskArtifact(task, "document:pitch");
  updateConversationFocus(task);
  expect(task.conversationFocus?.activeArtifactId).toBe("document:pitch");
  task.work!.activeGoalId = "another-goal";
  updateConversationFocus(task);
  expect(task.conversationFocus?.activeArtifactId).not.toBe("document:pitch");
});
