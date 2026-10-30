import { isIP } from "node:net";
import { z } from "zod";
import { readResponseText } from "./response-body";
import { XaiWebResearchProvider } from "./xai-web-research";
import { GeminiWebResearchProvider } from "./gemini-web-research";

export const ResearchQuerySchema = z.string().trim().min(3).max(300);

// Process-local spending safeguard. A distributed deployment additionally needs
// a shared quota before enabling unrestricted multi-instance concurrency.
const MAX_ACTIVE_RESEARCH = 3;
let activeResearch = 0;

export interface ResearchSource {
  id: string;
  title: string;
  url: string;
  snippet: string;
  /** Preview provided by the search service, never generated as a venue image. */
  imageUrl?: string;
  /** Optional actual page excerpt, never instructions to Igor. */
  excerpt?: string;
  retrievedAt: string;
}

export interface ResearchResult {
  status: "ok" | "partial" | "blocked" | "error";
  sources: ResearchSource[];
  requests: number;
  warning?: string;
}

export interface ResearchPageResult {
  status: "ok" | "blocked" | "error";
  requests: number;
  excerpt?: string;
  warning?: string;
}

export interface ResearchProvider {
  readonly available?: boolean;
  readonly pageReadAvailable?: boolean;
  research(query: string): Promise<ResearchResult>;
  /** One bounded follow-up SERP search selected after observing evidence. */
  searchOnce?(query: string): Promise<ResearchResult>;
  /** Open only an exact HTTPS URL already returned by a search, validated by the orchestrator. */
  readSource?(url: string): Promise<ResearchPageResult>;
}

const Organic = z.object({
  title: z.string(),
  link: z.string(),
  description: z
    .string()
    .nullish()
    .transform((value) => value ?? ""),
  image_url: z.string().nullish(),
  image: z
    .union([
      z.string(),
      z.object({ url: z.string() }).transform((value) => value.url),
    ])
    .nullish(),
});

export function parseResearchSearch(raw: string) {
  let data: unknown = JSON.parse(raw);

  // Bright Data can return the parsed body inside its response envelope.
  for (let depth = 0; depth < 2; depth++) {
    if (
      data &&
      typeof data === "object" &&
      "body" in data &&
      !("organic" in data)
    ) {
      const body = (data as { body: unknown }).body;
      data = typeof body === "string" ? JSON.parse(body) : body;
    }
  }

  const envelope = z.object({ organic: z.array(z.unknown()) }).parse(data);

  return envelope.organic.flatMap((item) => {
    const result = Organic.safeParse(item);

    return result.success ? [result.data] : [];
  });
}

/** Reuse images in pages already read by the research provider; no extra fetch. */
export function researchPagePreview(markdown: string, pageUrl: string) {
  for (const match of markdown.matchAll(
    /!\[([^\]]*)\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g,
  )) {
    if (
      /logo|favicon|avatar|tracking|pixel|badge|spacer/i.test(
        match[1] + " " + match[2],
      )
    ) {
      continue;
    }

    try {
      const image = publicResearchUrl(new URL(match[2], pageUrl).toString());

      if (image) {
        return image;
      }
    } catch {
      // Broken page metadata must not discard useful research.
    }
  }

  return undefined;
}

/** Reject local, non-HTTPS, credentialed and IP literal links before fetching.
 * Research pages are untrusted regardless of how they are retrieved. */
export function publicResearchUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/\.$/, "");

    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      u.href.length > 2048 ||
      isIP(host) ||
      !host.includes(".") ||
      /(^|\.)(?:localhost|local|internal|lan|test|invalid)$/.test(host) ||
      /(^|\.)(?:localhost|local|internal|lan|test|invalid)(\.|$)/.test(host) ||
      host.endsWith(".arpa")
    ) {
      return null;
    }

    u.hash = "";

    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Server-only, bounded Bright Data SERP + optional Web Unlocker research.
 * Both routes use Bright Data's documented POST /request API; no generic
 * model-provided URL is ever sent without validating an organic search result.
 */
export class BrightDataResearchProvider implements ResearchProvider {
  get available() {
    return Boolean(this.key && this.serpZone);
  }
  get pageReadAvailable() {
    return Boolean(this.key && this.unlockerZone);
  }
  constructor(
    private readonly key: string,
    private readonly serpZone: string,
    private readonly unlockerZone: string,
    private readonly transport: typeof fetch = fetch,
  ) {}

  async research(rawQuery: string): Promise<ResearchResult> {
    return this.runSearch(rawQuery, false);
  }

  async searchOnce(rawQuery: string): Promise<ResearchResult> {
    return this.runSearch(rawQuery, true);
  }

  async readSource(rawUrl: string): Promise<ResearchPageResult> {
    const url = publicResearchUrl(rawUrl);

    if (
      !url ||
      /^www\.google\.com\/goto\b/.test(
        new URL(url).host + new URL(url).pathname,
      )
    ) {
      return {
        status: "blocked",
        requests: 0,
        warning: "Unsafe or indirect source URL.",
      };
    }

    if (!this.key || !this.unlockerZone) {
      return {
        status: "blocked",
        requests: 0,
        warning: "Page reader not configured.",
      };
    }

    if (activeResearch >= MAX_ACTIVE_RESEARCH) {
      return {
        status: "blocked",
        requests: 0,
        warning: "Research concurrency limit reached.",
      };
    }

    activeResearch++;

    try {
      const excerpt = await this.request(this.unlockerZone, url, true);

      return { status: "ok", requests: 1, excerpt: excerpt.slice(0, 6000) };
    } catch {
      return {
        status: "error",
        requests: 1,
        warning: "Could not retrieve the selected public page.",
      };
    } finally {
      activeResearch--;
    }
  }

  private async runSearch(
    rawQuery: string,
    shallow: boolean,
  ): Promise<ResearchResult> {
    const query = ResearchQuerySchema.parse(rawQuery);

    if (!this.key || !this.serpZone) {
      return {
        status: "blocked",
        sources: [],
        requests: 0,
        warning:
          "Live web research is not configured. Configure the server-side Bright Data API key and SERP zone.",
      };
    }

    if (activeResearch >= MAX_ACTIVE_RESEARCH) {
      return {
        status: "blocked",
        sources: [],
        requests: 0,
        warning: "The live research concurrency limit is reached.",
      };
    }

    activeResearch++;

    try {
      return await this.executeResearch(query, shallow);
    } finally {
      activeResearch--;
    }
  }

  private async executeResearch(
    query: string,
    shallow = false,
  ): Promise<ResearchResult> {
    let requests = 0;
    const now = new Date().toISOString();
    const search = new URL("https://www.google.com/search");
    search.searchParams.set("q", query);
    search.searchParams.set("gl", "us");
    search.searchParams.set("hl", "en");

    let organic: z.infer<typeof Organic>[];

    try {
      requests++;
      const raw = await this.request(this.serpZone, search.toString(), false);
      organic = parseResearchSearch(raw);
    } catch {
      return {
        status: "error",
        sources: [],
        requests,
        warning: "The search provider could not return valid search results.",
      };
    }

    // A visually polished card is not useful when its "venue" is a social
    // post or a generic directory search. One bounded follow-up seeks direct
    // source pages for local planning. Other research keeps its one-call path.
    const lowValueHost = (url: string) => {
      try {
        const target = new URL(url);

        return (
          /(^|\.)(?:tiktok|reddit|facebook|youtube|instagram)\.com$/i.test(
            target.hostname,
          ) ||
          (/(^|\.)yelp\.com$/i.test(target.hostname) &&
            target.pathname.startsWith("/search")) ||
          target.hostname === "www.google.com" ||
          target.hostname === "google.com"
        );
      } catch {
        return true;
      }
    };

    const localIntent =
      /\b(?:cafes?|restaurants?|dining|venues?|hangout|outing|board.game|things to do)\b/i.test(
        query,
      );
    const primaryCount = organic.filter((item) => {
      const link = publicResearchUrl(item.link);

      return link && !lowValueHost(link);
    }).length;

    if (!shallow && localIntent && primaryCount < 2) {
      const second = new URL(search);
      second.searchParams.set(
        "q",
        query.slice(0, 170) +
          " official site -site:tiktok.com -site:reddit.com -site:facebook.com -site:yelp.com",
      );
      requests++;

      try {
        const focused = await this.request(
          this.serpZone,
          second.toString(),
          false,
        );
        organic = [...organic, ...parseResearchSearch(focused)];
      } catch {
        // The initial sources remain useful even if the focused search fails.
      }
    }

    organic.sort(
      (left, right) =>
        Number(!lowValueHost(right.link)) - Number(!lowValueHost(left.link)),
    );

    const seen = new Set<string>();
    const sources: ResearchSource[] = [];

    for (const item of organic) {
      const url = publicResearchUrl(item.link);

      if (!url || seen.has(url)) {
        continue;
      }

      seen.add(url);
      sources.push({
        id: `web-${sources.length + 1}`,
        title: item.title.slice(0, 200),
        url,
        snippet: item.description.slice(0, 900),
        // Ignore huge inline/base64 images and reject non-public image URLs.
        imageUrl:
          publicResearchUrl(item.image_url || item.image || "") ?? undefined,
        retrievedAt: now,
      });

      if (sources.length === 5) {
        break;
      }
    }

    if (!sources.length) {
      return {
        status: "partial",
        sources: [],
        requests,
        warning: "Search returned no usable public sources.",
      };
    }

    if (shallow || !this.unlockerZone) {
      return {
        status: "partial",
        sources,
        requests,
        warning:
          "Search snippets were retrieved, but page reading is not configured. Claims have not been checked against full pages.",
      };
    }

    // Two pages are the maximum: 1 search + 2 reads per request.
    // A single unavailable page does not erase the other retrieved sources.
    const domains = new Set<string>();
    const pages = sources
      .filter((source) => {
        const hostname = new URL(source.url).hostname;

        if (domains.has(hostname)) {
          return false;
        }

        domains.add(hostname);

        return true;
      })
      .slice(0, 2);
    const results = await Promise.allSettled(
      pages.map(async (source) => {
        requests++;
        const excerpt = await this.request(this.unlockerZone, source.url, true);

        return excerpt.slice(0, 6000);
      }),
    );
    let opened = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];

      if (result.status === "fulfilled" && result.value.trim()) {
        pages[i].excerpt = result.value;
        pages[i].imageUrl ??= researchPagePreview(result.value, pages[i].url);
        opened++;
      }
    }

    return {
      status: opened === pages.length ? "ok" : "partial",
      sources,
      requests,
      ...(opened === pages.length
        ? {}
        : {
            warning:
              "Some source pages could not be read. Unopened entries are search snippets only.",
          }),
    };
  }

  private async request(zone: string, url: string, markdown: boolean) {
    const response = await this.transport(
      "https://api.brightdata.com/request",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(12000),
        body: JSON.stringify({
          zone,
          url,
          // Use the parsed SERP JSON contract verified with this Bright Data
          // zone. The API may wrap it as { status_code, body }; the parser
          // accepts both the envelope and a direct organic result.
          format: markdown ? "raw" : "json",
          data_format: markdown ? "markdown" : "parsed",
        }),
      },
    );

    if (!response.ok) {
      throw new Error("Research provider rejected this request.");
    }

    // Parsed Google results may contain large inline image data even when
    // only a few organic entries are needed. Preserve a strict memory limit
    // without rejecting ordinary full-JSON SERP responses.
    return readResponseText(response, markdown ? 100000 : 2_000_000);
  }
}

export function runtimeResearchProvider(): ResearchProvider {
  const bright = new BrightDataResearchProvider(
    process.env.BRIGHTDATA_API_KEY ?? "",
    process.env.BRIGHTDATA_SERP_ZONE ?? "",
    process.env.BRIGHTDATA_UNLOCKER_ZONE ?? "",
  );

  if (bright.available) {
    return bright;
  }

  // Google Search grounding uses an independently verified entitlement.
  // Do not equate access to Gemini function calling with search access.
  const geminiKey =
    process.env.IGOR_GEMINI_WEB_SEARCH_ENABLED === "1"
      ? process.env.GEMINI_API_KEY || ""
      : "";

  if (geminiKey) {
    return new GeminiWebResearchProvider(
      geminiKey,
      process.env.GEMINI_SEARCH_MODEL || "gemini-2.5-flash",
    );
  }

  // Only advertise xAI search after its server-side web_search entitlement
  // has been verified. A working chat-completions key does not prove this tool.
  const key =
    process.env.IGOR_XAI_WEB_SEARCH_ENABLED === "1"
      ? process.env.XAI_API_KEY || process.env.GROK_API_KEY || ""
      : "";

  return key
    ? new XaiWebResearchProvider(
        key,
        process.env.XAI_SEARCH_MODEL || "grok-4.7",
      )
    : bright;
}
