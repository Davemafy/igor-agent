import {
  startRecorded,
  recordedTurn,
  requireOriginalArchive,
  keyboardMessage,
} from "./recorded-session";
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Task } from "../../src/core/contracts";

async function turn(
  page: Page,
  task: Task,
  action: Record<string, unknown>,
): Promise<Task> {
  requireOriginalArchive();
  const response = await page.request.post(`/api/tasks/${task.id}/turn`, {
    data: { ...action, version: task.brief.version },
  });
  expect(response.ok()).toBe(true);
  const events = (await response.text())
    .split("\n\n")
    .filter((s) => s.startsWith("data: "))
    .map((s) => JSON.parse(s.slice(6)));
  expect(events.some((e) => e.type === "error")).toBe(false);

  return events.find((e) => e.type === "done").task;
}

async function gathering(page: Page) {
  let task = (await (await page.request.post("/api/tasks")).json()) as Task;

  // Explicitly opt into the same sample profiles used by this recorded journey.
  // A fresh personal workspace must never silently inherit those tastes.
  task = await turn(page, task, { type: "sample", example: "common" });

  for (const text of [
    "Plan a gathering for six friends, budget $60 and 180 minutes.",
    "Use Moonlight from 2016.",
    "For Children of Men: cost $5, duration 80 minutes, access confirmed.",
    "For Thom Yorke: cost $5, duration 15 minutes, access confirmed.",
  ]) {
    task = await turn(page, task, { type: "message", text });
  }

  expect(task.status).toBe("ready");
  await page.addInitScript(
    (id) => localStorage.setItem("igor-task", id),
    task.id,
  );
  await page.goto("/workspace");

  return task;
}

test("recorded cultural outcome → collection → export → independent review → owner acceptance → revocation", async ({
  page,
  browser,
}) => {
  // This journey includes editing, export and an independent review context.
  // Individual UI assertions retain their normal bounded timeouts.
  test.setTimeout(160000);
  const task = await gathering(page);
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(
    page.getByText("From a taste to a new direction."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Saved", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "New collection", exact: true })
    .click();
  await page
    .getByLabel("Give it a name", { exact: true })
    .fill("Screening references");
  const checkSize = await page
    .getByRole("checkbox", { name: /Children of Men/ })
    .boundingBox();
  expect(checkSize?.width).toBeLessThanOrEqual(20);
  await page.getByRole("checkbox", { name: /Children of Men/ }).check();
  await page.getByRole("checkbox", { name: /Thom Yorke/ }).check();
  await page
    .getByRole("button", { name: "Save collection", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Screening references", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Screening references/ }).click();
  await page
    .getByLabel("Collection name", { exact: true })
    .fill("Screening references — revised");
  await page
    .getByRole("textbox", { name: "Your notes", exact: true })
    .fill("Keep the opening intimate. This is an owner-authored direction.");
  await page
    .getByRole("button", { name: "Move Children of Men down", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", {
      name: "Screening references — revised",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Your notes", exact: true }),
  ).toHaveValue(
    "Keep the opening intimate. This is an owner-authored direction.",
  );
  const savedBoards = await (
    await page.request.get(`/api/tasks/${task.id}/outputs`)
  ).json();
  expect(savedBoards.collections[0].revision).toBe(2);
  expect(savedBoards.collections[0].items[0].name).toBe("Thom Yorke");
  await page.screenshot({
    path: "/tmp/igor-current-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  await page.getByText("Save and share", { exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download Markdown" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.md$/);
  const text = await readFile((await download.path())!, "utf8");
  expect(text).toContain("## Evidence");
  expect(text).toContain("CACHED");
  expect(text).not.toContain(task.brief.owner);
  await page.getByLabel("Who is reviewing?").selectOption("amara");
  await page
    .getByRole("checkbox", { name: /I have reviewed the document/ })
    .check();
  await page
    .getByRole("button", { name: "Create review link", exact: true })
    .click();
  await expect(page.getByLabel("Your review link")).toBeVisible();
  const url = await page.getByLabel("Your review link").inputValue();
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  let reviewPhase = "guest-open";

  try {
    await guest.goto(url);
    await expect(
      guest.getByRole("heading", { name: "A fresh perspective.", exact: true }),
    ).toBeVisible();
    await guest
      .getByLabel("What works, or needs a little thought?")
      .fill("Please retain the listening interlude.");
    await guest
      .getByRole("button", { name: "Send feedback", exact: true })
      .click();
    await expect(guest.getByRole("status")).toContainText(
      "They choose whether to apply it.",
    );
    await guest
      .getByText("Suggest a taste correction", { exact: true })
      .click();
    await guest.getByLabel("Artist, film or interest").fill("Radiohead");
    await guest
      .getByLabel("Preference", { exact: true })
      .selectOption("not-now");
    await guest
      .getByRole("button", { name: "Propose correction", exact: true })
      .click();
    await expect(
      guest.getByRole("button", { name: "Propose correction", exact: true }),
    ).toBeDisabled();
    const before = (await (
      await page.request.get(`/api/tasks/${task.id}`)
    ).json()) as Task;
    expect(before.artifacts).toEqual(task.artifacts);
    expect(
      before.brief.participants[0].preferences.find(
        (p) => p.value === "Radiohead",
      )?.polarity,
    ).toBe("like");
    reviewPhase = "owner-refresh";
    await page
      .getByRole("button", {
        name: "Refresh",
        exact: true,
      })
      .click();
    await expect(
      page.getByText("Please retain the listening interlude.", { exact: true }),
    ).toBeVisible();
    reviewPhase = "owner-apply-preference";
    await page
      .getByRole("button", {
        name: "Apply proposed preference",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", { name: "Reviewed", exact: true }),
    ).toBeVisible();
    const after = (await (
      await page.request.get(`/api/tasks/${task.id}`)
    ).json()) as Task;
    expect(
      after.brief.participants[0].preferences.find(
        (p) => p.value === "Radiohead",
      )?.polarity,
    ).toBe("not-now");
    expect(after.brief.participants.slice(1)).toEqual(
      before.brief.participants.slice(1),
    );
    expect(after.receipts?.at(-1)?.culturalRequests).toBe(0);
    reviewPhase = "owner-revoke";
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    reviewPhase = "guest-revocation-check";
    await guest.reload();
    await expect(
      guest.getByRole("alert").filter({ hasText: /unavailable.*expired/ }),
    ).toContainText("unavailable or has expired");
  } finally {
    test
      .info()
      .annotations.push({ type: "review-phase", description: reviewPhase });
    console.info(`IGOR_REVIEW_PHASE=${reviewPhase}`);
    await guestContext.close();
  }
});

test("one-click Tokyo discovery renders actual mapped places and locality revision", async ({
  page,
}) => {
  let task = await startRecorded(page, {
    type: "place-example",
    city: "Tokyo",
  });
  const museum = task.candidates.find((c) => c.name === "Ghibli Museum")!;
  expect(museum.place?.latitude).toEqual(expect.any(Number));
  expect(museum.place?.longitude).toEqual(expect.any(Number));
  await expect(page.locator(".ic-spatial")).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Choose a place" }),
  ).toContainText("Ghibli Museum");
  await expect(
    page.getByText("Ghibli Museum", { exact: true }).first(),
  ).toBeVisible();
  task = await keyboardMessage(page, "Location: Amsterdam");
  expect(
    task.candidates.some((c) => c.name === "Moco Museum | Amsterdam"),
  ).toBe(true);
  expect(task.evidence.some((e) => e.summary.includes("Amsterdam"))).toBe(true);
  await expect(
    page.getByText("Moco Museum | Amsterdam", { exact: true }).first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("region", { name: "Your work", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(page.locator(".iw-pane-switch")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});

test("HTTP ownership, chunked bounds, memory continuity and share snapshots remain isolated", async ({
  page,
  browser,
}) => {
  let task = await gathering(page);
  const pref = task.brief.participants[0].preferences.find(
    (p) => p.value === "Radiohead",
  )!;
  task = await turn(page, task, {
    type: "memory",
    operation: "save",
    preferenceId: pref.id,
  });
  const another = (await (
    await page.request.post("/api/tasks")
  ).json()) as Task;
  expect(another.preferences.some((p) => p.id === pref.id)).toBe(true);
  const foreign = await browser.newContext();

  try {
    expect(
      (await foreign.request.get(`/api/tasks/${task.id}/outputs`)).status(),
    ).toBe(404);
    expect(
      (await foreign.request.get(`/api/tasks/${task.id}/export`)).status(),
    ).toBe(401);
  } finally {
    await foreign.close();
  }

  expect(
    (
      await page.request.post(`/api/tasks/${task.id}/outputs`, {
        data: { type: "share", artifactIds: ["main"], version: 0 },
      })
    ).status(),
  ).toBe(409);
  const share = await (
    await page.request.post(`/api/tasks/${task.id}/outputs`, {
      data: {
        type: "share",
        artifactIds: ["main"],
        version: task.brief.version,
      },
    })
  ).json();
  expect(share.token).toBeTruthy();
  const snapshot = await (
    await page.request.get(`/api/review/${share.token}`)
  ).json();
  task = await turn(page, task, { type: "constraints", budget: 1 });
  const preserved = await (
    await page.request.get(`/api/review/${share.token}`)
  ).json();
  expect(preserved.snapshot).toEqual(snapshot.snapshot);
  expect(preserved.snapshot.sourceVersion).not.toBe(task.brief.version);
  task = await turn(page, task, {
    type: "memory",
    operation: "delete",
    preferenceId: pref.id,
  });
  expect(
    (await (await page.request.get(`/api/tasks/${another.id}`)).json())
      .preferences,
  ).toEqual([]);
});

test("a geographic discovery continues into real artist references in the same conversation", async ({
  page,
}) => {
  let task = await startRecorded(page, {
    type: "place-example",
    city: "Tokyo",
  });
  const museum = task.candidates.find((c) => c.name === "Ghibli Museum")!;
  const people = structuredClone(task.brief.participants);
  task = await recordedTurn(page, task, {
    type: "connection",
    candidateId: museum.id,
    targetType: "artist",
  });
  expect(task.brief.contextAnchor?.name).toBe("Ghibli Museum");
  expect(task.brief.participants).toEqual(people);
  expect(task.candidates).toHaveLength(10);
  expect(
    task.candidates.every((c) => c.type === "artist" && c.available === null),
  ).toBe(true);
  await page.reload();
  await expect(
    page.getByText(task.candidates[0].name, { exact: true }).first(),
  ).toBeVisible();
});

test("local account registration preserves work, logout revokes access, and login restores saved workspaces", async ({
  page,
}) => {
  const task = await gathering(page);
  const username = `test_${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page
    .getByLabel("Password · at least 12 characters", { exact: true })
    .fill("synthetic-browser-password-2026");
  await page
    .getByRole("button", { name: "Create private account", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: `Your account · ${username}` }),
  ).toBeVisible();
  expect((await page.request.get(`/api/tasks/${task.id}`)).ok()).toBe(true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Account", exact: true }),
  ).not.toBeVisible();
  expect([401, 404]).toContain(
    (await page.request.get(`/api/tasks/${task.id}`)).status(),
  );
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByLabel("Account action").selectOption("login");
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page
    .getByLabel("Password · at least 12 characters", { exact: true })
    .fill("synthetic-browser-password-2026");
  await page
    .getByRole("checkbox", { name: /I understand that signing in/ })
    .check();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Account", exact: true }),
  ).not.toBeVisible();
  await expect
    .poll(async () =>
      (await page.request.get(`/api/tasks/${task.id}`)).status(),
    )
    .toBe(200);
});

test("a personal start uses only the user's supplied taste, without silently saving memory", async ({
  page,
}) => {
  const task = await startRecorded(page, {
    type: "personal-profile",
    name: "You",
    artist: "Radiohead",
  });
  expect(task.candidates).toHaveLength(30);
  expect(task.brief.participants).toHaveLength(1);
  expect(task.brief.participants[0].name).toBe("You");
  expect(task.preferences).toEqual([]);
  await expect(
    page.getByText(task.candidates[0].name, { exact: true }).first(),
  ).toBeVisible();
});
