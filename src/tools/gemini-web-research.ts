import { z } from "zod";
import { readResponseText } from "./response-body";
import {
  publicResearchUrl,
  ResearchQuerySchema,
  type ResearchProvider,
  type ResearchResult,
} from "./live-research";

const GroundingResponse = z.object({
  candidates: z
    .array(
      z.object({
        groundingMetadata: z
          .object({
            groundingChunks: z
              .array(
                z.object({
                  web: z
                    .object({
                      uri: z.string().optional(),
                      title: z.string().optional(),
                    })
                    .optional(),
                }),
              )
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

/**
 * Optional Google Search grounding. Never uses generated text as source proof.
 * Only Google-returned groundingChunks.web URIs qualify as source leads.
 * These are grounding citations, not independently verified page excerpts.
 */
export class GeminiWebResearchProvider implements ResearchProvider {
  readonly pageReadAvailable = false;

  get available() {
    return Boolean(this.key);
  }

  constructor(
    private readonly key: string,
    private readonly model = "gemini-2.5-flash",
    private readonly transport: typeof fetch = fetch,
  ) {}

  async research(query: string): Promise<ResearchResult> {
    return this.searchOnce(query);
  }

  async searchOnce(rawQuery: string): Promise<ResearchResult> {
    if (!this.available) {
      return { status: "blocked", sources: [], requests: 0 };
    }

    const query = ResearchQuerySchema.parse(rawQuery);

    try {
      const response = await this.transport(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": this.key,
            "Content-Type": "application/json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(35000),
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text:
                      "Use Google Search to find relevant public sources. Prefer reputable primary sources. " +
                      "Do not invent URLs. Research question: " +
                      query,
                  },
                ],
              },
            ],
            tools: [{ google_search: {} }],
            generationConfig: { maxOutputTokens: 800 },
          }),
        },
      );

      if (!response.ok) {
        return {
          status: "error",
          sources: [],
          requests: 1,
          warning: `Google Search grounding returned HTTP ${response.status}.`,
        };
      }

      const json = GroundingResponse.parse(
        JSON.parse(await readResponseText(response, 500000)),
      );
      const seen = new Set<string>();
      const sources: ResearchResult["sources"] = [];

      for (const chunk of json.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []) {
        const rawUrl = chunk.web?.uri;
        const url = rawUrl ? publicResearchUrl(rawUrl) : null;

        if (!url || seen.has(url)) {
          continue;
        }

        seen.add(url);
        sources.push({
          id: `web-${sources.length + 1}`,
          title: chunk.web?.title?.trim().slice(0, 160) || new URL(url).hostname,
          url,
          snippet:
            "Google Search grounding citation. Verify individual claims before treating them as confirmed.",
          retrievedAt: new Date().toISOString(),
        });

        if (sources.length >= 8) {
          break;
        }
      }

      return {
        status: sources.length ? "partial" : "blocked",
        sources,
        requests: 1,
        warning: sources.length
          ? "Google Search returned grounding citations; source pages were not independently opened."
          : "Google Search returned no structured grounded web citations.",
      };
    } catch {
      return {
        status: "error",
        sources: [],
        requests: 1,
        warning: "Google Search grounding failed before returning valid sources.",
      };
    }
  }
}
