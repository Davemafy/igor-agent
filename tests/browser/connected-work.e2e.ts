import { test, expect, type Page } from "@playwright/test";
import type { Task } from "../../src/core/contracts";
import { mkdirSync } from "node:fs";

async function saved(page: Page): Promise<Task> {
  return page.evaluate(async () => {
    const id = localStorage.getItem("igor-task");
    const response = await fetch(`/api/tasks/${id}`);

    if (!response.ok) {
      throw new Error("Saved workspace unavailable");
    }

    return response.json();
  });
}

async function showPane(page: Page, name: "Conversation" | "Your work") {
  const control = page
    .getByRole("navigation", { name: "Conversation and work" })
    .getByRole("button", { name, exact: true });

  if (await control.isVisible()) {
    await control.click();
    await expect(control).toHaveAttribute("aria-pressed", "true");
  }
}

async function message(page: Page, text: string) {
  await showPane(page, "Conversation");
  const input = page.getByRole("textbox", {
    name: "Message Igor",
    exact: true,
  });
  await expect(input).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("igor-task")))
    .toBeTruthy();
  await expect(page.locator(".iw-composer")).toHaveAttribute(
    "data-busy",
    "false",
  );
  const previous = (await saved(page)).brief.version;
  await input.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect
    .poll(async () => (await saved(page)).brief.version)
    .toBeGreaterThan(previous);
  await expect(input).toBeEnabled();
  await expect(page.locator(".iw-messages")).toHaveAttribute(
    "aria-busy",
    "false",
  );

  return saved(page);
}

test("existing chat UI carries a listening-bar concept through approvals, edits, budget revision and reload (scripted fixtures)", async ({
  page,
}, info) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (e) => runtimeErrors.push(e.message));
  await page.goto("/app");
  await expect(
    page.getByRole("textbox", { name: "Message Igor", exact: true }),
  ).toBeEnabled();
  await message(page, "hey");
  let task = await message(
    page,
    "I want to launch a small listening bar for people into alternative music and independent art. Help me make it distinctive without overspending.",
  );
  expect(task.work?.documents).toHaveLength(8);
  await showPane(page, "Your work");
  console.log("IGOR_INTEGRATION_WORK_DIAGNOSTIC", JSON.stringify(await page.evaluate(() => ({
    url: location.pathname + location.search,
    hasConnectedSurface: !!document.querySelector('[aria-label="Connected work"]'),
    resultCount: document.querySelectorAll(".iw-inline-output").length,
    resourceTabs: [...document.querySelectorAll(".iw-resource-tabs button")].map((element) => element.textContent?.trim()),
    documentTabs: document.querySelectorAll(".ig-connected-doc-tabs button").length,
    pageState: document.querySelector(".iw-inline-workspace")?.getAttribute("data-pane"),
    workCopy: document.querySelector(".iw-workspace")?.textContent?.slice(0, 240),
    errors: [...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent?.slice(0, 180)),
  }))));
  const surface = page.getByRole("complementary", { name: "Connected work" });
  await expect(surface).toBeVisible();
  await surface
    .getByRole("button", { name: "Launch brief", exact: true })
    .click();
  const overview = surface.getByRole("region", { name: "Saved work overview" });
  await expect(overview).toContainText("Launch brief");
  await expect(overview).toContainText("WORKING PROPOSAL");
  const messageCountBeforeViewing = (await saved(page)).messages.length;
  await page.reload();
  await expect(surface).toHaveAttribute(
    "data-active-artifact-id",
    "document:listening-bar-launch",
  );
  expect((await saved(page)).messages).toHaveLength(messageCountBeforeViewing);

  await surface.getByRole("button", { name: "Expand connected work" }).click();
  await expect(surface).toHaveClass(/ic-fullscreen/);
  await surface.getByRole("button", { name: "Edit document" }).click();
  const editor = surface.getByRole("textbox", { name: "Edit Launch brief" });
  await editor.fill(
    "Invite a small pilot community. This sentence is my exact wording.",
  );
  const oldVersion = (await saved(page)).work!.documents.find(
    (d) => d.id === "listening-bar-launch",
  )!.version;
  await surface.getByRole("button", { name: "Save changes" }).click();
  await expect
    .poll(
      async () =>
        (await saved(page)).work!.documents.find(
          (d) => d.id === "listening-bar-launch",
        )!.version,
    )
    .toBeGreaterThan(oldVersion);
  await expect(editor).toHaveValue(
    "Invite a small pilot community. This sentence is my exact wording.",
  );
  await surface.getByRole("button", { name: "Preview" }).click();
  const compareControl = surface.getByRole("button", {
    name: "Compare saved versions",
  });
  const compareCount = await compareControl.count();
  test.info().annotations.push({
    type: "compare-control",
    description: JSON.stringify({
      count: compareCount,
      visible: compareCount === 1 ? await compareControl.isVisible() : false,
      geometry:
        compareCount === 1
          ? await compareControl.evaluate((el) => {
              const r = el.getBoundingClientRect();

              return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                viewportHeight: innerHeight,
              };
            })
          : null,
    }),
  });
  await surface.getByRole("button", { name: "Compare saved versions" }).click();
  const compared = surface.locator(".ig-work-version-pair");
  await expect(compared).toContainText("PREVIOUS");
  await expect(compared).toContainText("CURRENT");
  await expect(compared).toContainText("This sentence is my exact wording.");
  await surface
    .getByRole("button", { name: "Hide saved version comparison" })
    .click();
  await expect(compared).toHaveCount(0);
  await surface
    .getByRole("combobox", { name: "Document revision" })
    .selectOption(String(oldVersion));
  await expect(surface.getByLabel("Document preview")).not.toContainText(
    "my exact wording",
  );
  await surface
    .getByRole("combobox", { name: "Document revision" })
    .selectOption("current");

  if (info.project.name.includes("mobile")) {
    mkdirSync("test-results/morphing", { recursive: true });
    await page.screenshot({
      path: `test-results/morphing/${info.project.name}-connected-artifact.png`,
    });
  }

  await surface.getByRole("button", { name: "Close expanded work" }).click();
  await expect(surface).not.toHaveClass(/ic-fullscreen/);
  await showPane(page, "Conversation");
  await expect(page.locator(".iw-message.iw-assistant").last()).toContainText(
    "Launch brief: saved your wording.",
  );
  const contextualMessage = page.waitForRequest(
    (request) =>
      request.url().endsWith("/turn") &&
      request.method() === "POST" &&
      request.postDataJSON()?.text === "Budget: 1000",
  );
  await message(page, "Budget: 1000");
  expect((await contextualMessage).postDataJSON().context).toEqual({
    artifactId: "document:listening-bar-launch",
  });
  expect((await saved(page)).conversationFocus?.activeArtifactId).toBe(
    "document:listening-bar-launch",
  );
  await message(page, "Approve Musical identity");
  await message(
    page,
    "Edit listening-bar-invite: Our exact invitation wording.",
  );
  const before = await saved(page);
  task = await message(
    page,
    "Cut the budget by 30%, keep the musical identity, and preserve everything I already approved.",
  );
  expect(task.work?.budget?.amount).toBe(700);
  expect(task.work?.budgetHistory.at(-1)?.amount).toBe(1000);
  expect(
    task.work?.decisions.find((d) => d.id === "listening-bar-identity")?.status,
  ).toBe("approved");
  expect(
    task.work?.documents.find((d) => d.id === "listening-bar-invite")?.content,
  ).toBe("Our exact invitation wording.");
  expect(
    task.work?.documents.find((d) => d.id === "listening-bar-concept"),
  ).toEqual(
    before.work?.documents.find((d) => d.id === "listening-bar-concept"),
  );
  expect(
    task.work?.documents.find((d) => d.id === "listening-bar-launch")?.content,
  ).toBe("Invite a small pilot community. This sentence is my exact wording.");
  expect(
    task.work?.documents.find((d) => d.id === "listening-bar-allocation")
      ?.history.length,
  ).toBeGreaterThan(0);
  expect(task.receipts!.every((r) => r.culturalRequests === 0)).toBe(true);
  await expect(page.locator(".iw-message.iw-assistant").last()).toContainText(
    "$700",
  );
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message Igor", exact: true }),
  ).toBeEnabled();
  expect((await saved(page)).work).toEqual(task.work);
  expect(runtimeErrors).toEqual([]);
});

test("technical recommendation changes audience without replacing its decision or unrelated documents (recorded development example)", async ({
  page,
}) => {
  await page.goto("/app");
  await expect(
    page.getByRole("textbox", { name: "Message Igor", exact: true }),
  ).toBeEnabled();
  await message(page, "I want to launch a small listening bar.");
  const unrelated = (await saved(page)).work!.documents;
  await message(
    page,
    "Research three frontend frameworks and prepare a technical recommendation for my team.",
  );
  await message(page, "Approve Framework recommendation");
  const before = (await saved(page)).work!.documents.find(
    (d) => d.id === "framework-report",
  )!;
  const task = await message(
    page,
    "Keep the recommendation, but change the audience to beginner developers and shorten the report.",
  );
  const report = task.work!.documents.find((d) => d.id === "framework-report")!;
  expect(report.id).toBe(before.id);
  expect(report.version).toBe(before.version + 1);
  expect(report.history.at(-1)?.content).toBe(before.content);
  expect(report.content).toContain("Recorded development fixture");
  expect(
    task.work?.decisions.find((d) => d.id === "framework-choice")?.status,
  ).toBe("approved");
  expect(
    task.work?.documents.filter((d) => d.goalId === "listening-bar"),
  ).toEqual(unrelated);
  expect(task.receipts!.every((r) => r.culturalRequests === 0)).toBe(true);
  expect(report.content).toContain("shortened for beginners");
  await showPane(page, "Your work");
  const work = page.getByRole("complementary", { name: "Connected work" });
  await work
    .getByRole("button", { name: "Technical recommendation", exact: true })
    .click();
  await expect(work).toContainText("shortened for beginners");
});
