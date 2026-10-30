import { describe, expect, it, vi } from "vitest";
import { GeminiWebResearchProvider } from "../../src/tools/gemini-web-research";

describe("Gemini grounded web research provider", () => {
  it("returns only structured grounding URLs, never free-text model links", async () => {
    const sourceUrl = "https://www.iea.org/reports/global-ev-outlook-2026";
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: "Model-generated claim https://fictional.example/claim",
                },
              ],
            },
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    uri: sourceUrl,
                    title: "IEA report",
                  },
                },
                { web: { uri: "https://localhost/private" } },
                { web: { uri: sourceUrl } },
              ],
            },
          },
        ],
      }),
    );
    const provider = new GeminiWebResearchProvider(
      "test-key",
      "gemini-2.5-flash",
      transport,
    );
    const response = await provider.searchOnce("EV charging infrastructure");

    expect(response.status).toBe("partial");
    expect(response.sources).toHaveLength(1);
    expect(response.sources[0].url).toBe(sourceUrl);
    expect(response.sources[0].title).toBe("IEA report");
    const [endpoint, options] = transport.mock.calls[0];
    expect(String(endpoint)).toContain("gemini-2.5-flash:generateContent");
    expect(JSON.parse(String(options?.body))).toMatchObject({
      tools: [{ google_search: {} }],
    });
  });

  it("keeps unsourced generated text out of research evidence", async () => {
    const provider = new GeminiWebResearchProvider(
      "test-key",
      "gemini-2.5-flash",
      async () =>
        Response.json({
          candidates: [
            {
              content: {
                parts: [{ text: "A fabricated fact https://fake.example" }],
              },
            },
          ],
        }),
    );

    expect(await provider.research("EV market overview")).toMatchObject({
      status: "blocked",
      sources: [],
    });
  });

  it("reports provider refusal without inventing sources", async () => {
    const provider = new GeminiWebResearchProvider(
      "test-key",
      "gemini-2.5-flash",
      async () => new Response("not allowed", { status: 403 }),
    );

    expect(await provider.research("EV market overview")).toMatchObject({
      status: "error",
      sources: [],
      requests: 1,
    });
  });

  it("remains unavailable without credentials", async () => {
    const provider = new GeminiWebResearchProvider("");

    expect(provider.available).toBe(false);
    expect(await provider.research("EV charging competitors")).toMatchObject({
      status: "blocked",
      sources: [],
      requests: 0,
    });
  });
});
