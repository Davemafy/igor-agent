import { expect, it, vi } from "vitest";
import { WikipediaResearchProvider } from "../../src/tools/wikipedia-research";

it("only returns actually retrieved Wikipedia entries as provisional leads", async () => {
  const transport = vi.fn<typeof fetch>(async (url) => {
    const parsed = new URL(String(url));

    expect(parsed.origin).toBe("https://en.wikipedia.org");
    expect(parsed.pathname).toBe("/w/rest.php/v1/search/page");
    expect(parsed.searchParams.get("q")).toBe("electric vehicle charging");

    return Response.json({
      pages: [
        {
          id: 123,
          key: "Electric_vehicle_charging_station",
          title: "Charging station",
          excerpt:
            '<span class="searchmatch">Electric</span> charging infrastructure',
          description: "General background",
        },
      ],
    });
  });
  const provider = new WikipediaResearchProvider(transport);
  const result = await provider.searchOnce("electric vehicle charging");

  expect(result.status).toBe("partial");
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0].url).toBe(
    "https://en.wikipedia.org/wiki/Electric_vehicle_charging_station",
  );
  expect(result.sources[0].snippet).toBe("Electric charging infrastructure");
  expect(result.warning).toContain("do not verify current market figures");
  expect(transport).toHaveBeenCalledOnce();
});

it("fails closed on malformed, oversized or unsuccessful responses", async () => {
  const unavailable = new WikipediaResearchProvider(
    vi.fn<typeof fetch>(
      async () => new Response("unavailable", { status: 503 }),
    ),
  );
  const broken = new WikipediaResearchProvider(
    vi.fn<typeof fetch>(async () => Response.json({ notPages: [] })),
  );

  expect((await unavailable.research("charging")).sources).toEqual([]);
  expect((await broken.searchOnce("charging")).status).toBe("error");
  expect((await broken.research("x")).requests).toBe(0);
});
