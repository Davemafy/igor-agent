import { expect, test, type Page } from "@playwright/test";
import type { Task } from "../../src/core/contracts";
import { DatabaseSync } from "node:sqlite";
import {
  installPresentation,
  PresentationSchema,
} from "../../src/core/presentation";

async function act(page: Page, task: Task, action: Record<string, unknown>) {
  const response = await page.request.post(`/api/tasks/${task.id}/turn`, {
    data: { ...action, version: task.brief.version },
  });
  expect(response.ok()).toBe(true);
  const events = (await response.text())
    .split("\n\n")
    .filter((event) => event.startsWith("data: "))
    .map((event) => JSON.parse(event.slice(6)));
  expect(events.some((event) => event.type === "error")).toBe(false);

  return events.find((event) => event.type === "done").task as Task;
}

test("recorded Qloo gathering produces a native, editable invitation — desktop and mobile", async ({
  page,
}, testInfo) => {
  let task = (await (await page.request.post("/api/tasks")).json()) as Task;
  task = await act(page, task, { type: "sample" });

  for (const text of [
    "Use Moonlight from 2016.",
    "For Children of Men: cost $5, duration 80 minutes, access confirmed.",
    "For Thom Yorke: cost $5, duration 15 minutes, access confirmed.",
  ]) {
    task = await act(page, task, { type: "message", text });
  }

  expect(task.brief.kind).toBe("gathering");
  expect(task.mode).toBe("qloo-live");
  expect(task.artifacts.some((item) => item.id === "invitation")).toBe(true);

  await page.addInitScript(
    (id) => localStorage.setItem("igor-task", id),
    task.id,
  );
  await page.goto(`/app?task=${task.id}`);

  const studio = page.getByRole("region", {
    name: "Your gathering invitation",
  });
  await expect(studio).toBeVisible();
  await expect(studio.getByLabel("Invitation poster preview")).toBeVisible();
  await expect(studio.getByText("DATE TO BE DECIDED")).toBeVisible();
  await expect(
    studio
      .getByText(/nothing is sent|nothing was sent|hasn.t contacted/i)
      .first(),
  ).toBeVisible();

  // Source artwork is external and optional. Give returned images time to
  // settle before the proof capture; an unavailable image stays a legible
  // reference poster rather than an empty white card.
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll(".ei-print img")].every(
          (node) => (node as HTMLImageElement).complete,
        ),
      undefined,
      { timeout: 10000 },
    )
    .catch(() => {});

  await page.screenshot({
    path: testInfo.outputPath("igor-native-invitation-desktop.png"),
    animations: "disabled",
  });
  await studio.getByLabel("Invitation poster preview").screenshot({
    path: testInfo.outputPath("igor-native-invitation-poster.png"),
    animations: "disabled",
  });

  const title = studio.getByLabel("Invitation title");
  const message = studio.getByLabel("Message to your people");
  await title.fill("Films, friends & something unexpected");
  await message.fill(
    "We have a plan in progress. Date and location still to confirm.",
  );
  await expect(studio.getByLabel("Invitation poster preview")).toContainText(
    "Films, friends & something unexpected",
  );

  await studio.getByRole("button", { name: "Save changes" }).click();
  await expect
    .poll(async () => {
      const current = (await (
        await page.request.get(`/api/tasks/${task.id}`)
      ).json()) as Task;

      return current.artifacts.find((item) => item.id === "invitation")
        ?.content;
    })
    .toContain("# Films, friends & something unexpected");

  await studio.getByRole("button", { name: "Midnight" }).click();
  await expect(studio.getByLabel("Invitation poster preview")).toHaveAttribute(
    "data-style",
    "ink",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await studio.scrollIntoViewIfNeeded();
  await expect(page.locator(".iw-pane-switch")).toHaveCount(0);
  await expect(studio).toBeVisible();
  await studio.getByLabel("Invitation poster preview").screenshot({
    path: testInfo.outputPath("igor-native-invitation-mobile-poster.png"),
    animations: "disabled",
  });
  await studio.locator(".ei-heading").evaluate((element) => {
    element.scrollIntoView({ block: "start", behavior: "instant" });
  });
  await page.screenshot({
    path: testInfo.outputPath("igor-native-invitation-mobile.png"),
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
});

test("a gathering without a saved invitation opens its actual work, not a placeholder poster", async ({
  page,
}) => {
  const response = await page.request.post("/api/tasks");
  expect(response.ok()).toBe(true);
  const task = (await response.json()) as Task;
  task.status = "ready";
  task.brief.kind = "gathering";
  task.brief.goal = "Dinner in New York";
  task.messages = [
    {
      role: "user",
      text: "dinner in new york",
      at: new Date().toISOString(),
    },
  ];
  task.artifacts = [];
  task.canvas = installPresentation(
    undefined,
    PresentationSchema.parse({
      id: "dinner-discovery",
      title: "Dinner in New York",
      basis: "user-supplied",
      root: "request",
      nodes: [
        {
          id: "request",
          type: "text",
          text: "Discover options for dinner in New York.",
        },
      ],
    }),
  );

  const db = new DatabaseSync(".igor/e2e/recorded/tasks.sqlite");
  const updated = db
    .prepare("UPDATE tasks SET state=? WHERE id=?")
    .run(JSON.stringify(task), task.id);
  expect(updated.changes).toBe(1);
  db.close();

  await page.addInitScript(
    (id) => localStorage.setItem("igor-task", id),
    task.id,
  );
  await page.goto(`/app?task=${task.id}`);

  await expect(
    page.getByRole("complementary", { name: "Task canvas" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Your gathering invitation" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Invitation", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Untitled gathering")).toHaveCount(0);
  await expect(page.getByText("Dinner in New York").first()).toBeVisible();
});
