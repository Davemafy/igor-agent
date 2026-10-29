import { expect, it, vi } from "vitest";
import { freshTask } from "../../src/data/fixtures";
import { pendingQuestionAnswer } from "../../src/core/pending-question";
import { updateConversationFocus } from "../../src/core/conversation-focus";
import { sourceLinkedDocumentMedia } from "../../src/core/document-media";
import { validatePresentation } from "../../src/core/presentation";
import { SqliteTaskStore } from "../../src/data/store";
import { runTurn } from "../../src/core/orchestrator";
import { ToolCallingModel } from "../../src/tools/tool-model";

const at = "2026-10-29T20:00:00.000Z";

function giftTask() {
  const task = freshTask("gift-occasion", "owner");
  task.messages = [
    {
      role: "user",
      text: "Help me find a thoughtful gift for my girlfriend.",
      at,
    },
    {
      role: "assistant",
      kind: "conversation",
      text: "What are her interests?",
      at,
    },
    { role: "user", text: "Fishing and fast food", at },
    {
      role: "assistant",
      kind: "conversation",
      text: "What's the occasion, and roughly what budget do you have?",
      at,
    },
  ];

  return task;
}

it("grounds proposal in the outstanding occasion question", () => {
  const task = giftTask();
  const answer = pendingQuestionAnswer(task, "proposal");

  expect(answer).toEqual({
    answer: "proposal",
    question: "What's the occasion, and roughly what budget do you have?",
  });
  expect(pendingQuestionAnswer(task, "birthday")?.answer).toBe("birthday");
  expect(pendingQuestionAnswer(task, "under $100")?.answer).toBe("under $100");
  expect(
    pendingQuestionAnswer(task, "write me a business proposal"),
  ).toBeNull();
  expect(pendingQuestionAnswer(task, "actually, change the topic")).toBeNull();

  updateConversationFocus(task);
  expect(task.conversationFocus?.pendingQuestion).toMatchObject({
    prompt: "What's the occasion, and roughly what budget do you have?",
    messageIndex: 3,
  });
});

it("routes a short occasion answer to the original gift goal", async () => {
  const task = giftTask();
  const requests: string[] = [];
  const model = new ToolCallingModel(
    "test-key",
    "test-model",
    vi.fn<typeof fetch>(async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      const selected = payload.tools[0].name;
      const prompt = JSON.stringify(payload.input);
      requests.push(selected);

      if (selected === "route_conversation") {
        expect(prompt).toContain("What's the occasion");
        expect(prompt).toContain("rather than requesting a new document");

        return Response.json({
          status: "completed",
          output: [
            {
              type: "function_call",
              name: selected,
              arguments: JSON.stringify({ intent: "draft" }),
            },
          ],
        });
      }

      expect(selected).toBe("compose_draft");
      expect(prompt).toContain("Fishing and fast food");
      expect(prompt).toContain("latestUserAnswer");
      expect(prompt).toContain("proposal");
      expect(prompt).toContain("Continue the original user request");

      return Response.json({
        status: "completed",
        output: [
          {
            type: "function_call",
            name: selected,
            arguments: JSON.stringify({
              title: "Proposal-day gift and experience ideas",
              content:
                "A tentative marriage proposal idea: a lakeside fishing picnic, with her favorite fast food. Confirm the meaning of proposal when refining.",
            }),
          },
        ],
      });
    }),
  );
  const db = new SqliteTaskStore(":memory:");

  try {
    db.create(task);
    const output = await runTurn(
      db,
      task.id,
      "owner",
      { type: "message", text: "proposal", version: 0 },
      () => {},
      undefined,
      model,
    );

    expect(requests).toEqual(["route_conversation", "compose_draft"]);
    expect(output.status).not.toBe("error");
    expect(output.canvas?.surface.nodes).toMatchObject([
      {
        type: "document",
        title: "Proposal-day gift and experience ideas",
      },
    ]);
    expect(db.load(task.id, "owner").messages.at(-2)?.text).toBe("proposal");
    expect(output.conversationFocus?.pendingQuestion).toBeNull();
  } finally {
    db.close();
  }
});

it("validates only current sourced candidate imagery", () => {
  const task = freshTask("media-document", "owner");
  const candidate = task.catalogue[0];
  const saved = {
    ...candidate,
    sample: false,
    imageUrl: "https://images.qloo.com/sample-tokyo.webp",
    freshness: "current" as const,
    eligibility: "eligible" as const,
    dependencies: [],
    missing: [],
    violations: [],
    evidenceIds: [],
    fit: {},
    fitReason: "Test candidate",
  };
  task.candidates = [saved];
  const media = sourceLinkedDocumentMedia(
    task,
    `A thoughtful weekend featuring ${candidate.name} and a relaxed dinner.`,
  );

  expect(media).toEqual([
    {
      candidateId: candidate.id,
      alt: `Provider image for ${candidate.name}`,
      caption: candidate.name,
    },
  ]);

  const surface = {
    id: "image-brief",
    title: "Visual brief",
    basis: "draft",
    root: "doc",
    nodes: [
      {
        id: "doc",
        type: "document",
        content: "An editable proposal with source-linked imagery.",
        media,
      },
    ],
  };

  expect(validatePresentation(surface, task).nodes[0]).toMatchObject({
    media,
  });
  expect(() =>
    validatePresentation(
      {
        ...surface,
        nodes: [
          {
            ...surface.nodes[0],
            media: [{ ...media[0], candidateId: "invented-candidate" }],
          },
        ],
      },
      task,
    ),
  ).toThrow("Document images must reference");

  task.candidates[0].freshness = "stale";
  expect(() => validatePresentation(surface, task)).toThrow(
    "Document images must reference",
  );
  expect(sourceLinkedDocumentMedia(task, candidate.name)).toEqual([]);
});
