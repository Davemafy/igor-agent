import { z } from "zod";
import type { ResearchProvider, ResearchResult } from "./live-research";

const SearchResponse = z.object({
  pages: z.array(
    z.object({
      id: z.number().int(),
      key: z.string().min(1),
      title: z.string().min(1),
      excerpt: z.string().nullish(),
      description: z.string().nullish(),
    }),
  ),
});

/**
 * Narrow, credential-free research fallback. Wikipedia is useful for
 * background and entity discovery, NOT current prices, availability,
 * company filings, or investment-grade primary evidence.
 */
export class WikipediaResearchProvider implements ResearchProvider {
  readonly available = true;
  readonly pageReadAvailable = false;

  constructor(private readonly transport: typeof fetch = fetch) {}

  research(query: string): Promise<ResearchResult> {
    return this.searchOnce(query);
  }

  async searchOnce(query: string): Promise<ResearchResult> {
    const cleaned = query.trim().slice(0, 200);

    if (cleaned.length < 3) {
      return {
        status: "blocked",
        sources: [],
        requests: 0,
        warning: "A specific research query is required.",
      };
    }

    const url = new URL("https://en.wikipedia.org/w/rest.php/v1/search/page");
    url.searchParams.set("q", cleaned);
    url.searchParams.set("limit", "6");

    try {
      const response = await this.transport(url.toString(), {
        headers: {
          Accept: "application/json",
          "User-Agent": "Igor/0.1 (https://github.com/Davemafy/igor)",
          "Api-User-Agent": "Igor/0.1 (https://github.com/Davemafy/igor)",
        },
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        return {
          status: "error",
          sources: [],
          requests: 1,
          warning: "Wikipedia background lookup did not succeed.",
        };
      }

      const raw = await response.text();

      if (raw.length > 120000) {
        throw new Error("Oversize background response");
      }

      const data = SearchResponse.parse(JSON.parse(raw));
      const stripMarkup = (text: string) =>
        text
          .replace(/<[^>]*>/g, " ")
          .replace(/&(?:quot|ldquo|rdquo);/g, '"')
          .replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 450);
      const retrievedAt = new Date().toISOString();
      const sources = data.pages.slice(0, 6).map((page, index) => ({
        id: `wiki-${index + 1}`,
        title: page.title.slice(0, 160),
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.key).replace(/%20/g, "_")}`,
        snippet: stripMarkup(page.excerpt || page.description || page.title),
        retrievedAt,
      }));

      return {
        status: sources.length ? "partial" : "blocked",
        sources,
        requests: 1,
        warning:
          "Encyclopedic background only: Wikipedia results do not verify current market figures, prices, availability or investment claims.",
      };
    } catch {
      return {
        status: "error",
        sources: [],
        requests: 1,
        warning: "Wikipedia lookup was unavailable; no source was invented.",
      };
    }
  }
}
