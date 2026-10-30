import { z } from "zod";
import { readResponseText } from "./response-body";
import {
  publicResearchUrl,
  ResearchQuerySchema,
  type ResearchProvider,
  type ResearchResult,
} from "./live-research";

const SearchResponse = z.object({
  status: z.string().optional(),
  citations: z.array(z.string()).optional(),
  usage: z
    .object({
      server_side_tool_usage_details: z
        .object({ web_search_calls: z.number().int().nonnegative().optional() })
        .optional(),
    })
    .optional(),
});

/**
 * Optional real web discovery when a Bright Data search zone is not configured.
 * Uses xAI's documented Responses API server-side web_search capability.
 * URLs must be returned as structured provider citations; free-form model text
 * is never promoted to evidence, and citations are leads rather than verified
 * page contents. No fabricated search results or fallback fixtures.
 */
export class XaiWebResearchProvider implements ResearchProvider {
  readonly pageReadAvailable = false;
  get available() {
    return Boolean(this.key);
  }

  constructor(
    private readonly key: string,
    private readonly model = "grok-4.7",
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
      const response = await this.transport("https://api.x.ai/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          model: this.model,
          max_turns: 2,
          input: [
            {
              role: "user",
              content:
                "Use live web search to find reputable public sources for this research question. " +
                "Return a concise answer with links. Do not invent sources. Question: " +
                query,
            },
          ],
          tools: [{ type: "web_search" }],
        }),
      });

      if (!response.ok) {
        return {
          status: "error",
          sources: [],
          requests: 1,
          warning: `xAI web search provider returned HTTP ${response.status}.`,
        };
      }

      const json = SearchResponse.parse(
        JSON.parse(await readResponseText(response, 500000)),
      );

      if (json.status && json.status !== "completed") {
        return {
          status: "partial",
          sources: [],
          requests: 1,
          warning: "Web search did not complete; no sources promoted to evidence.",
        };
      }

      const seen = new Set<string>();
      const urls: string[] = [];

      for (const rawUrl of json.citations ?? []) {
        const url = publicResearchUrl(rawUrl);

        if (!url || seen.has(url)) {
          continue;
        }

        seen.add(url);
        urls.push(url);

        if (urls.length === 8) {
          break;
        }
      }

      return {
        status: urls.length > 0 ? "partial" : "blocked",
        sources: urls.map((url, index) => ({
          id: `web-${index + 1}`,
          title: new URL(url).hostname,
          url,
          snippet:
            "Provider-returned web-search citation. Verify page facts before treating claims as confirmed.",
          retrievedAt: new Date().toISOString(),
        })),
        requests: 1,
        warning:
          urls.length > 0
            ? "These citations were encountered by xAI web search; the pages were not independently re-read."
            : "xAI returned no validated web-source citations.",
      };
    } catch {
      return {
        status: "error",
        sources: [],
        requests: 1,
        warning: "xAI web search could not return validated sources.",
      };
    }
  }
}
