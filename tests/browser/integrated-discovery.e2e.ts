import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sampleCatalogue } from "../../src/data/fixtures";
import {
  installPresentation,
  PresentationSchema,
} from "../../src/core/presentation";
import type { Task } from "../../src/core/contracts";

for (const { mobile, reduced } of [
  { mobile: false, reduced: false },
  { mobile: true, reduced: false },
  { mobile: true, reduced: true },
]) {
  test(`persistent candidate inspection ${mobile ? "mobile" : "desktop"}${reduced ? " reduced motion" : ""}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    );
    await page.emulateMedia({
      reducedMotion: reduced ? "reduce" : "no-preference",
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const created = await page.request.post("/api/tasks", {
      headers: { Origin: "http://127.0.0.1:3560" },
    });
    expect(created.ok()).toBe(true);
    const task = (await created.json()) as Task;
    task.status = "ready";
    task.messages = [
      {
        role: "user",
        text: "Explore these recorded sample films",
        at: new Date().toISOString(),
      },
      {
        role: "assistant",
        kind: "conversation",
        text: "Sample fixture: select, compare and save these references. No live Qloo call.",
        at: new Date().toISOString(),
      },
    ];
    task.candidates = sampleCatalogue()
      .slice(0, 3)
      .map((c) => ({
        ...c,
        eligibility: "eligible",
        dependencies: [],
        freshness: "current",
        missing: [],
        violations: [],
        evidenceIds: [],
        fit: {},
        fitReason: "SAMPLE — illustrative test only",
      }));
    task.canvas = installPresentation(
      undefined,
      PresentationSchema.parse({
        id: "connected-discovery",
        title: "Sample cultural references",
        basis: "draft",
        root: "choices",
        nodes: [
          {
            id: "choices",
            type: "discovery",
            title: "References",
            candidateIds: task.candidates.map((c) => c.id),
          },
        ],
      }),
    );
    const db = new DatabaseSync(
      `${process.env.IGOR_BROWSER_RUN_DIR ?? ".igor/integration-browser"}/tasks.sqlite`,
    );
    db.prepare("UPDATE tasks SET state=? WHERE id=?").run(
      JSON.stringify(task),
      task.id,
    );
    db.close();
    await page.addInitScript(
      (id) => localStorage.setItem("igor-task", id),
      task.id,
    );
    await page.goto("/app");

    await expect(
      page.getByRole("region", { name: "Your work", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".iw-pane-switch")).toHaveCount(0);

    const card = page.locator('[data-candidate-id="moonrise"]');
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Read details" }).click();
    const detail = page.getByRole("region", {
      name: "Details for Moonrise Kingdom",
    });
    await expect(detail).toBeFocused();
    await expect(
      detail.locator('[data-candidate-id="moonrise"]'),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("detail.png"),
      fullPage: true,
    });
    await page.evaluate(() => {
      const samples: { at: number; paths: string[] }[] = [];
      Object.assign(window, {
        __igorFluidSamples: samples,
        __igorFluidSampling: true,
      });
      const start = performance.now();

      const frame = () => {
        const root = document.querySelector("[data-fluid-candidate]");
        const paths = [
          ...(root?.querySelectorAll<HTMLElement>("[style]") ?? []),
        ]
          .map((el) => el.style.clipPath)
          .filter(Boolean);
        samples.push({
          at: performance.now() - start,
          paths: [...new Set(paths)],
        });

        if (
          (window as unknown as { __igorFluidSampling: boolean })
            .__igorFluidSampling
        ) {
          requestAnimationFrame(frame);
        }
      };

      frame();
    });
    const fluid = detail.getByRole("switch", { name: "Include in comparison" });
    await detail.getByText("Include in comparison", { exact: true }).click();
    await expect(fluid).toBeChecked();
    await page.waitForTimeout(550);
    await page.screenshot({ path: info.outputPath("fluid-split.png") });
    await detail.getByText("Include in comparison", { exact: true }).click();
    await expect(fluid).not.toBeChecked();
    await page.waitForTimeout(1100);
    // Screenshot latency must not end sampling before the rejoin starts.
    // Require the actual geometry to settle within a bounded deadline.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const samples = (
              window as unknown as {
                __igorFluidSamples: { at: number; paths: string[] }[];
              }
            ).__igorFluidSamples;

            return new Set(
              samples.slice(-8).map((s) => JSON.stringify(s.paths)),
            ).size;
          }),
        { timeout: 5000 },
      )
      .toBeLessThanOrEqual(2);
    await page.evaluate(() => {
      Object.assign(window, { __igorFluidSampling: false });
    });
    const samples = await page.evaluate(
      () =>
        (
          window as unknown as {
            __igorFluidSamples: { at: number; paths: string[] }[];
          }
        ).__igorFluidSamples,
    );
    const unique = [...new Set(samples.flatMap((s) => s.paths))];

    if (!reduced) {
      expect(unique.length).toBeGreaterThan(3);
      expect(unique.some((p) => p.includes("C"))).toBe(true);
    }

    // No continuing geometry loop once the interaction has settled.
    expect(
      new Set(samples.slice(-8).map((s) => JSON.stringify(s.paths))).size,
    ).toBeLessThanOrEqual(2);
    await info.attach("fluid-geometry", {
      body: JSON.stringify(samples),
      contentType: "application/json",
    });
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Read details" }).first(),
    ).toBeFocused();
    await card.getByRole("button", { name: "Choose", exact: true }).click();
    await expect(
      card.getByRole("button", { name: "Selected", exact: true }),
    ).toBeVisible();
    await page.reload();

    await expect(
      page.getByRole("region", { name: "Your work", exact: true }),
    ).toBeVisible();

    await expect(
      page
        .locator('[data-candidate-id="moonrise"]')
        .getByRole("button", { name: "Selected", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .locator('[data-candidate-id="moonrise"]')
      .getByRole("button", { name: "Compare", exact: true })
      .click();
    await page
      .locator('[data-candidate-id="arrival"]')
      .getByRole("button", { name: "Compare", exact: true })
      .click();
    await page
      .locator(".iw-liquid-toolbar")
      .getByRole("button", { name: /Compare/ })
      .click();
    await expect(
      page.locator(".iw-liquid-compare-grid [data-candidate-id]"),
    ).toHaveCount(2);
    await page.screenshot({
      path: info.outputPath("comparison.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
    await page.screenshot({
      path: info.outputPath("saved-reloaded.png"),
      fullPage: true,
    });
  });
}

test("original Codrops gallery switches real candidate layout without losing inspection", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const created = await page.request.post("/api/tasks", {
    headers: { Origin: "http://127.0.0.1:3560" },
  });
  expect(created.ok()).toBe(true);
  const task = (await created.json()) as Task;
  task.status = "ready";
  task.messages = [
    {
      role: "user",
      text: "Explore cultural directions",
      at: new Date().toISOString(),
    },
    {
      role: "assistant",
      kind: "conversation",
      text: "SAMPLE fixture with existing local media; not a Qloo live result.",
      at: new Date().toISOString(),
    },
  ];
  const examples = [
    {
      name: "Aalto & light",
      type: "artist" as const,
      description:
        "An editorial design reference from the local sample artwork library.",
    },
    {
      name: "A night for Alex",
      type: "place" as const,
      description:
        "A sample invitation and candlelit gathering, not a verified venue.",
    },
    {
      name: "Colour studies",
      type: "artist" as const,
      description: "A graphic poster from the local sample artwork library.",
    },
  ];
  task.candidates = sampleCatalogue()
    .slice(0, 3)
    .map((candidate, index) => ({
      ...candidate,
      ...examples[index],
      imageUrl: `https://images.qloo.com/igor-sample-c0${index + 1}.webp`,
      eligibility: "eligible",
      dependencies: [],
      freshness: "current",
      missing: [],
      violations: [],
      evidenceIds: [],
      fit: {},
      fitReason: "SAMPLE only; no cultural association inferred",
    }));
  task.canvas = installPresentation(
    undefined,
    PresentationSchema.parse({
      id: "original-codrops-layout",
      title: "Recorded layout experiment",
      basis: "draft",
      root: "choices",
      nodes: [
        {
          id: "choices",
          type: "discovery",
          title: "References",
          candidateIds: task.candidates.map((candidate) => candidate.id),
        },
      ],
    }),
  );
  const db = new DatabaseSync(
    `${process.env.IGOR_BROWSER_RUN_DIR ?? ".igor/integration-browser"}/tasks.sqlite`,
  );
  db.prepare("UPDATE tasks SET state=? WHERE id=?").run(
    JSON.stringify(task),
    task.id,
  );
  db.close();
  await page.route(
    "https://images.qloo.com/igor-sample-*.webp",
    async (route) => {
      const match = route
        .request()
        .url()
        .match(/igor-sample-c0([1-3])[.]webp$/);

      if (!match) {
        await route.abort();

        return;
      }

      const media = await readFile(
        resolve(
          process.cwd(),
          "public/marketing/assets/covers",
          `c0${match[1]}.webp`,
        ),
      );
      await route.fulfill({
        status: 200,
        contentType: "image/webp",
        body: media,
      });
    },
  );
  await page.addInitScript(
    (id) => localStorage.setItem("igor-task", id),
    task.id,
  );
  // Explicit task URL ensures the browser opens the fixture-backed task,
  // not a newly created empty workspace from a previous session.
  await page.goto(`/app?task=${task.id}`);
  const work = page.getByRole("button", { name: "Your work", exact: true });

  if (await work.isVisible()) {
    await work.click();
  }

  await expect(
    page.getByRole("button", { name: "Expand canvas" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Expand canvas" }).click();
  await expect(
    page.getByRole("complementary", { name: "Task canvas" }),
  ).toHaveClass(/ic-fullscreen/);
  const gallery = page.locator(".iw-liquid-grid.grid_gallery_container");
  await expect(gallery).toHaveAttribute("data-size-grid", "150%");
  await expect(gallery.locator('[data-gallery="true"]')).toHaveCount(3);
  await expect(page.getByText("EXAMPLE ARTWORK")).toBeVisible();
  const first = gallery.locator('[data-candidate-id="moonrise"]');
  await expect(
    first.getByRole("button", { name: "Inspect Aalto & light" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("original-gallery.png") });
  const initial = await first.boundingBox();

  await page
    .getByRole("group", { name: "Discovery layout" })
    .getByRole("button", { name: "Detailed" })
    .click();
  await expect(gallery).toHaveAttribute("data-size-grid", "75%");
  await expect(first.getByRole("button", { name: "Choose" })).toBeVisible();
  expect(initial).not.toBeNull();
  await expect
    .poll(async () => {
      const detailed = await first.boundingBox();

      return Math.abs((initial?.width ?? 0) - (detailed?.width ?? 0));
    })
    .toBeGreaterThan(20);
  await page.screenshot({ path: info.outputPath("original-detailed.png") });

  await page
    .getByRole("group", { name: "Discovery layout" })
    .getByRole("button", { name: "Gallery" })
    .click();
  await first.getByRole("button", { name: "Inspect Aalto & light" }).click();
  await expect(
    page.getByRole("dialog", { name: "Details for Aalto & light" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Details for Aalto & light" }),
  ).toBeFocused();
  await expect(
    page.getByText("SAMPLE only; no cultural association inferred"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close details" }).click();
  await expect(gallery).toHaveAttribute("data-size-grid", "150%");
});
