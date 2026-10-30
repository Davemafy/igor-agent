import { describe, expect, it, vi } from "vitest";
import { GeminiModel } from "../../src/tools/gemini-model";
import { freshTask } from "../../src/data/fixtures";

const documentTool = {
  name: "document.create",
  description: "Save sourced work",
  permission: "internal" as const,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      content: { type: "string" },
      sourceIds: { type: "array", items: { type: "string" } },
    },
    required: ["title", "content", "sourceIds"],
  },
};

describe("Gemini document function schema compatibility", () => {
  it("retries only the read-only decision after an unsupported provider schema", async () => {
    const modes: boolean[] = [];
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const parameters =
        body.tools[0].functionDeclarations[0].parametersJsonSchema.properties
          .arguments;
      modes.push(parameters.additionalProperties === false);

      if (modes.length === 1) {
        return Response.json(
          {
            error: {
              message: "request-schema unsupported additionalProperties",
            },
          },
          { status: 400 },
        );
      }

      return Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: "choose_agent_action",
                    args: {
                      name: "document.create",
                      arguments: {
                        title: "Source-backed report",
                        content:
                          "Observed research evidence and open questions.",
                        sourceIds: [],
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      });
    });

    const model = new GeminiModel(
      "test-key",
      "gemini-3.1-flash-lite",
      transport,
    );

    const result = await model.chooseAgentAction(
      "Save sourced work",
      [documentTool],
      [],
      freshTask("schema-repair", "owner"),
    );

    expect(result.name).toBe("document.create");
    expect(result.arguments.title).toBe("Source-backed report");
    expect(modes).toEqual([true, false]);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("does not repeat an unauthorized credential failure", async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: { message: "API key authentication failed" } },
        { status: 400 },
      ),
    );
    const model = new GeminiModel(
      "bad-key",
      "gemini-3.1-flash-lite",
      transport,
    );

    await expect(
      model.chooseAgentAction(
        "Save sourced work",
        [documentTool],
        [],
        freshTask("bad-schema-credentials", "owner"),
      ),
    ).rejects.toThrow();
    expect(transport).toHaveBeenCalledOnce();
  });
});
