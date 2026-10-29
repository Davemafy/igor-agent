import { test, expect } from "@playwright/test";
import { freshTask } from "../../src/data/fixtures";

function capturedResearchTask() {
  const task = freshTask("visual-outing", "owner");
  task.status = "ready";
  task.messages = [
    {
      role: "user",
      text: "Find a board game cafe for five in New York this Saturday",
      at: "2026-10-28T07:00:00Z",
    },
    {
      role: "assistant",
      kind: "conversation",
      text: "Sources: [web-1] https://example.com/venue; [web-2] https://www.yelp.com/search?q=board-games",
      evidenceIds: ["web-1", "web-2"],
      at: "2026-10-28T07:00:01Z",
    },
  ];
  task.evidence = [
    {
      id: "web-1",
      source: "provider-returned",
      kind: "practical",
      reference: "https://example.com/venue",
      title: "A board-game cafe",
      previewImageUrl: "https://images.example.com/venue.jpg",
      at: "2026-10-28T07:00:01Z",
      entityIds: [],
      summary: "A board-game cafe: Games, food and drinks. Check group tables.",
      limitations: ["Prices and Saturday availability unverified."],
      explanation: null,
      dependencies: [],
      freshness: "current",
    },
    {
      id: "web-2",
      source: "provider-returned",
      kind: "practical",
      reference: "https://www.yelp.com/search?q=board-games",
      title: "Neighborhood directory",
      at: "2026-10-28T07:00:01Z",
      entityIds: [],
      summary: "Neighborhood directory: Search results, not a venue listing.",
      limitations: ["Snippet only."],
      explanation: null,
      dependencies: [],
      freshness: "current",
    },
  ];
  task.artifacts = [
    {
      id: "web-research-1",
      kind: "research-report",
      title: "New York — options to check",
      content:
        "# Explored options\n\nThe user can open the full research notes here.",
      version: 1,
      dependencies: ["evidence:research"],
      evidenceIds: ["web-1", "web-2"],
      assumptions: ["No booking confirmed"],
      freshness: "current",
      edited: false,
    },
  ];

  return task;
}

test("real desktop research view is editorial and does not dump URLs or activity traces into the conversation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.addInitScript(() =>
    localStorage.setItem("igor-task", "visual-outing"),
  );
  await page.route("**/api/tasks/visual-outing", (route) =>
    route.fulfill({ status: 200, json: capturedResearchTask() }),
  );
  await page.route("**/api/tasks", (route) =>
    route.fulfill({ status: 200, json: { tasks: [] } }),
  );
  await page.route("https://images.example.com/venue.jpg", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450"><rect width="600" height="450" fill="#dce5d0"/><text x="32" y="220" font-size="28" fill="#536347">Source image fixture</text></svg>',
    }),
  );
  await page.route("**/api/tasks/visual-outing/outputs", (route) =>
    route.fulfill({
      status: 200,
      json: { collections: [], shares: [], reviews: [] },
    }),
  );
  await page.goto("/app");
  const gallery = page.getByRole("region", {
    name: "Visual research findings",
  });
  await expect(gallery).toBeVisible();
  await expect(gallery.locator(".ird-card")).toHaveCount(2);
  await expect(
    gallery.getByRole("heading", { name: "New York — options to check" }),
  ).toBeVisible();
  await expect(gallery.locator("img")).toHaveAttribute(
    "src",
    "https://images.example.com/venue.jpg",
  );
  const imageBox = await gallery.locator("img").boundingBox();
  expect(imageBox!.width).toBeGreaterThan(250);
  // Source-backed media leads the composition; missing photography becomes
  // numbered type, not an invented venue image or generic file icon.
  await expect(gallery.locator(".ird-card").first()).toHaveCSS(
    "border-radius",
    "0px",
  );
  await expect(gallery.locator(".ird-reference-number")).toContainText("02");
  await expect(page.locator(".iw-inline-output")).toHaveCSS(
    "scrollbar-gutter",
    "auto",
  );
  await expect(gallery.getByText("About these sources")).toBeVisible();
  await gallery.getByRole("button", { name: "Open A board-game cafe" }).click();
  const detail = page.getByRole("dialog", { name: "A closer look" });
  await expect(detail).toBeVisible();
  await expect(
    detail.getByRole("link", { name: "Open source" }),
  ).toHaveAttribute("href", "https://example.com/venue");
  await detail.getByText("Source details", { exact: true }).click();
  await expect(
    detail.getByText("Prices and Saturday availability unverified."),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/research-source-detail.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(detail).not.toBeVisible();
  await expect(
    gallery.getByRole("button", { name: "Open A board-game cafe" }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Research notes" }),
  ).toBeVisible();
  await expect(page.locator(".iw-message.iw-assistant")).not.toContainText(
    "https://example.com/venue",
  );
  await expect(page.getByText("tool.invoke:search_web")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "test-results/editorial-research-desktop.png",
    fullPage: true,
  });
});

test("mobile research cards retain legible typography and a single-column layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() =>
    localStorage.setItem("igor-task", "visual-outing"),
  );
  await page.route("**/api/tasks/visual-outing", (route) =>
    route.fulfill({ status: 200, json: capturedResearchTask() }),
  );
  await page.route("**/api/tasks", (route) =>
    route.fulfill({ status: 200, json: { tasks: [] } }),
  );
  await page.route("**/api/tasks/visual-outing/outputs", (route) =>
    route.fulfill({
      status: 200,
      json: { collections: [], shares: [], reviews: [] },
    }),
  );
  await page.goto("/app");
  await page.locator(".ird-gallery .ird-card").first().scrollIntoViewIfNeeded();
  await expect(page.locator(".iw-pane-switch")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Your work", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Conversation", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".ird-gallery .ird-card")).toHaveCount(2);
  const columns = await page
    .locator(".ird-gallery")
    .evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  expect(columns.trim().split(/\s+/).length).toBe(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const composer = await page.locator(".iw-workspace-footer").boundingBox();
  const thread = await page.locator(".iw-messages").boundingBox();
  expect(thread!.y + thread!.height).toBeLessThanOrEqual(composer!.y + 1);
  await page.screenshot({
    path: "test-results/editorial-research-mobile.png",
    fullPage: true,
  });
  await expect(
    page.getByRole("textbox", { name: "Message Igor", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Conversation", exact: true }),
  ).toBeVisible();
});

test("short landscape scrolls the continuous conversation above the composer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 994, height: 410 });
  await page.addInitScript(() =>
    localStorage.setItem("igor-task", "visual-outing"),
  );
  await page.route("**/api/tasks/visual-outing", (route) =>
    route.fulfill({ status: 200, json: capturedResearchTask() }),
  );
  await page.route("**/api/tasks", (route) =>
    route.fulfill({ status: 200, json: { tasks: [] } }),
  );
  await page.route("**/api/tasks/visual-outing/outputs", (route) =>
    route.fulfill({
      status: 200,
      json: { collections: [], shares: [], reviews: [] },
    }),
  );
  await page.goto("/app");
  const work = page.locator(".iw-inline-output");
  await expect(work).toBeVisible();
  const before = await work.boundingBox();
  await page.locator(".iw-nav").hover();
  const after = await work.boundingBox();
  expect(after!.x).toBe(before!.x);
  const composer = await page.locator(".iw-workspace-footer").boundingBox();
  const thread = page.locator(".iw-messages");
  const threadBox = await thread.boundingBox();
  expect(threadBox!.y + threadBox!.height).toBeLessThanOrEqual(composer!.y + 1);
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(410);
  expect(await thread.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
    true,
  );
  expect(
    await work.evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
  ).toBe(true);
  await page.locator(".ird-card").last().scrollIntoViewIfNeeded();
  await expect(page.locator(".ird-card").last()).toBeInViewport({
    ratio: 0.05,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
