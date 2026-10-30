import { describe, expect, it, vi } from "vitest";
import { XaiWebResearchProvider } from "../../src/tools/xai-web-research";

describe("xAI grounded web source adapter", () => {
  it("returns only validated structured citations, never model-generated links", async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({
        status: "completed",
        citations: [
          "https://www.iea.org/reports/global-ev-outlook-2026",
          "https://www.iea.org/reports/global-ev-outlook-2026",
          "http://127.0.0.1/admin",
          "https://localhost/secret",
          "https://example.org/public",
        ],
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Fake fact [[1]](https://invented.example/fake)",
              },
            ],
          },
        ],
      }),
    );
    const provider = new XaiWebResearchProvider(
      "fixture-key",
      "grok-4.7",
      transport,
    );
    const result = await provider.research("EV charging market competitors");

    expect(result.status).toBe("partial");
    expect(result.sources.map((source) => source.url)).toEqual([
      "https://www.iea.org/reports/global-ev-outlook-2026",
      "https://example.org/public",
    ]);
    const sourceExplanationsAreUnverified = result.sources.every((source) =>
      source.snippet.includes("Verify"),
    );

    expect(sourceExplanationsAreUnverified).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
    const [url, options] = transport.mock.calls[0];
    expect(url).toBe("https://api.x.ai/v1/responses");
    expect(JSON.parse(String(options?.body))).toMatchObject({
      tools: [{ type: "web_search" }],
      max_turns: 2,
      model: "grok-4.7",
    });
  });

  it("does not fabricate sources on a provider error", async () => {
    const provider = new XaiWebResearchProvider(
      "fixture-key",
      "grok-4.7",
      async () => new Response("bad request", { status: 400 }),
    );
    const result = await provider.research("EV charging investments");

    expect(result.status).toBe("error");
    expect(result.requests).toBe(1);
    expect(result.sources).toEqual([]);
  });

  it("does not interpret a model answer as source evidence when citations are missing", async () => {
    const provider = new XaiWebResearchProvider(
      "fixture-key",
      "grok-4.7",
      async () =>
        Response.json({
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Official data at https://example.com/fake",
                },
              ],
            },
          ],
        }),
    );
    const result = await provider.research("EV charging market news");

    expect(result.status).toBe("blocked");
    expect(result.sources).toEqual([]);
  });

  it("is disabled without an authorized key", async () => {
    const provider = new XaiWebResearchProvider("");
    expect(provider.available).toBe(false);
    expect(await provider.research("EV charging market")).toMatchObject({
      status: "blocked",
      sources: [],
      requests: 0,
    });
  });
});
