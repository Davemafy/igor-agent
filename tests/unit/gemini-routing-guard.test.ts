import { describe, expect, it, vi } from "vitest";
import { GeminiModel } from "../../src/tools/gemini-model";
import { needsEvidenceDrivenExecution } from "../../src/tools/tool-model";
import { freshLiveTask } from "../../src/data/live-task";

const key = "test-only-provider-key";
const task = () => freshLiveTask("routing-guard", "test-owner");

function modelProposingDraft() {
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({
      modelVersion: "gemini-3.1-flash-lite",
      candidates: [
        {
          finishReason: "STOP",
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "route_conversation",
                  args: { intent: "draft" },
                },
              },
            ],
          },
        },
      ],
    }),
  );

  return {
    model: new GeminiModel(key, "gemini-3.1-flash-lite", transport),
    transport,
  };
}

describe("Gemini read-only routing safety boundary", () => {
  it("corrects the exact live Brooklyn failure without using another model call", async () => {
    const input =
      "I run a 100-capacity space in Brooklyn. Our community loves Sade, " +
      "Radiohead and Wong Kar-wai films. Design an unexpected Saturday " +
      "experience under $3,000 and save an editable proposal, schedule " +
      "and partner pitch. Label unverified practical facts.";
    const { model, transport } = modelProposingDraft();

    expect(needsEvidenceDrivenExecution(input)).toBe(true);
    expect(await model.routeConversation(input, task())).toEqual({
      intent: "research",
      query: input.slice(0, 300),
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(model.calls).toBe(1);
  });

  it("does not downgrade real-world vendor investigation into an unsourced draft", async () => {
    const input = "Research local caterers, compare prices and draft a vendor shortlist.";
    const { model } = modelProposingDraft();

    expect(await model.routeConversation(input, task())).toMatchObject({
      intent: "research",
    });
  });

  it.each([
    "Write an original fictional short story about a train station.",
    "Draft a one-page proposal for my imaginary science-fiction board game.",
    "Create an email inviting a colleague to review the supplied document.",
  ])("preserves standalone writing intent: %s", async (input) => {
    const { model } = modelProposingDraft();

    expect(needsEvidenceDrivenExecution(input)).toBe(false);
    expect(await model.routeConversation(input, task())).toEqual({
      intent: "draft",
    });
  });
});
