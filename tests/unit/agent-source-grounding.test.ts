import { describe, expect, it } from "vitest";
import { groundDocumentSources } from "../../src/core/agent-source-grounding";
import type { ResearchSource } from "../../src/tools/live-research";

const observed: ResearchSource[] = [
  {
    id: "web-1",
    title: "Official charging report",
    url: "https://example.org/research",
    snippet: "Observed provider result",
    retrievedAt: "2026-10-31T00:00:00Z",
  },
  {
    id: "web-2",
    title: "Network directory",
    url: "https://example.org/networks",
    snippet: "Observed provider result",
    retrievedAt: "2026-10-31T00:00:00Z",
  },
];

describe("agent document source grounding", () => {
  it("accepts only IDs, URLs and evidence IDs from observed sources", () => {
    expect(
      groundDocumentSources(
        ["web-1", "https://example.org/networks", "task:agent:run:web-1"],
        "Research memo",
        observed,
        "task",
        "run",
      ),
    ).toEqual({ ids: ["web-1", "web-2"], rejected: [] });
  });

  it("recovers exact inline citations without crediting invented source IDs", () => {
    expect(
      groundDocumentSources(
        ["web-40"],
        "An observed point [web-2], not a claim about source web-40.",
        observed,
        "task",
        "run",
      ),
    ).toEqual({ ids: ["web-2"], rejected: ["web-40"] });
  });

  it("does not infer unsupported IDs from source titles or partial tokens", () => {
    expect(
      groundDocumentSources(
        ["web-40"],
        "Official charging report; web-1 and hypothetical web-2",
        observed,
        "task",
        "run",
      ),
    ).toEqual({ ids: [], rejected: ["web-40"] });
  });

  it("accepts a URL visibly quoted in a document as a real citation", () => {
    expect(
      groundDocumentSources(
        [],
        "The source is https://example.org/research",
        observed,
        "task",
        "run",
      ),
    ).toEqual({ ids: ["web-1"], rejected: [] });
  });
});
