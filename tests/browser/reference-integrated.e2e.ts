import { expect, test } from "@playwright/test";

test("cinematic Home accepts arbitrary editable prompts without domain intake", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: /Your agent.*With taste/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find a place" })).toBeVisible();
  await page.getByRole("button", { name: "Find a place" }).click();
  await expect(page.getByRole("textbox", { name: "Message Igor" })).toHaveValue(/find a place/);
  await page.getByRole("textbox", { name: "Message Igor" }).fill("Explain the major differences between two database indexes.");
  await expect(page.getByRole("textbox", { name: "Message Igor" })).toHaveValue(/database indexes/);
  await page.screenshot({ path: "test-results/reference-native-home-desktop.png" });
});

test("Discover opens in the same authenticated workspace, with honest empty results", async ({ page }) => {
  await page.goto("/app?view=explore");
  await expect(page.getByRole("searchbox", { name: "Discover across any domain" })).toBeVisible();
  await expect(page.locator(".ir-reference-tile")).toHaveCount(0);
  await expect(page.locator(".ir-discovery-start-links > button")).toHaveCount(4);
  await expect(page.getByRole("navigation", { name: "Product navigation" }).getByRole("button", { name: "Create" })).toBeVisible();
  await page.screenshot({ path: "test-results/reference-native-discover-desktop.png" });
});

test("mobile navigation keeps all primary actions accessible without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");
  const nav = page.getByRole("navigation", { name: "Product navigation" });
  for (const name of ["Home", "Explore", "Create", "Search", "Library"]) {
    await expect(nav.getByRole("button", { name })).toBeVisible();
  }
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);
  await page.screenshot({ path: "test-results/reference-native-home-mobile.png" });
  await nav.getByRole("button", { name: "Explore" }).click();
  await expect(page.getByRole("searchbox", { name: "Discover across any domain" })).toBeVisible();
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);
  await page.screenshot({ path: "test-results/reference-native-discover-mobile.png" });
});

test("Home reconstructs the supplied desktop visual grid at original dimensions", async ({ page }) => {
  await page.setViewportSize({ width: 1448, height: 1086 });
  await page.goto("/app");
  const elements = {
    sidebar: page.locator(".iw-nav"),
    title: page.locator(".iw-intro h1"),
    search: page.locator(".iw-welcome .iw-composer"),
    chips: page.locator(".iw-quick-start"),
    firstCard: page.locator(".iw-story-card").first(),
    lastCard: page.locator(".iw-story-card").last(),
  };
  const box = async (locator: typeof elements.sidebar) => {
    const rect = await locator.boundingBox();
    expect(rect).toBeTruthy();
    return rect!;
  };
  const sidebar = await box(elements.sidebar);
  const title = await box(elements.title);
  const search = await box(elements.search);
  const chips = await box(elements.chips);
  const firstCard = await box(elements.firstCard);
  const lastCard = await box(elements.lastCard);
  console.log("IGOR_VISUAL_METRIC_HOME",JSON.stringify({ sidebar, title, search, chips, firstCard, lastCard }));
  expect(sidebar.width).toBeGreaterThan(185);
  expect(sidebar.width).toBeLessThan(230);
  expect(firstCard.y).toBeGreaterThan(chips.y);
  expect(lastCard.x).toBeGreaterThan(firstCard.x + 700);
  await page.screenshot({path:"test-results/igor-reference-home-1448.png", fullPage:false});
});

test("Discover empty state has real actions and no invented recommendations", async ({page}) => {
  await page.setViewportSize({width:1448,height:1086});
  await page.goto("/app?view=explore");
  const starts=page.getByRole("region",{name:"Start a source-backed discovery"});
  await expect(starts).toBeVisible();
  await expect(starts.getByRole("button",{name:"Find a film"})).toBeVisible();
  await expect(starts.getByRole("button",{name:"Explore music"})).toBeVisible();
  await expect(page.locator(".ir-reference-tile")).toHaveCount(0);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({path:"test-results/igor-reference-explore-1448.png",fullPage:false});
});

test("shared Igor navigation keeps Home and Explore distinct and supports browser history", async ({ page }) => {
  await page.goto("/app?view=explore");
  const nav = page.getByRole("navigation", { name: "Product navigation" });
  await expect(page.getByRole("searchbox", { name: "Discover across any domain" })).toBeVisible();

  await nav.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(/view=home/);
  await expect(page.getByRole("heading", { name: /Your agent.*With taste/i })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");

  await page.goBack();
  await expect(page).toHaveURL(/view=explore/);
  await expect(page.getByRole("searchbox", { name: "Discover across any domain" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Explore", exact: true })).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "Igor home" }).click();
  await expect(page).toHaveURL(/view=home/);
  await expect(page.getByRole("heading", { name: /Your agent.*With taste/i })).toBeVisible();
});

test("headlines maintain real word spacing and appearance controls never obscure starter cards", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/app");
  const title = page.locator(".iw-intro h1");
  await expect(title).toBeVisible();
  const metrics = await title.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      wordSpacing: Number.parseFloat(style.wordSpacing),
      tracking: Number.parseFloat(style.letterSpacing),
      text: element.textContent || "",
    };
  });
  expect(metrics.text).toContain("Your agent.");
  expect(metrics.text).toContain("With taste.");
  expect(metrics.wordSpacing).toBeGreaterThan(5);
  expect(metrics.tracking).toBeGreaterThan(-3.5);

  const appearance = await page.locator(".iw-appearance-trigger").boundingBox();
  const lastStory = await page.locator(".iw-story-card").last().boundingBox();
  expect(appearance).not.toBeNull();
  expect(lastStory).not.toBeNull();
  const overlap = !!appearance && !!lastStory &&
    appearance.x < lastStory.x + lastStory.width &&
    appearance.x + appearance.width > lastStory.x &&
    appearance.y < lastStory.y + lastStory.height &&
    appearance.y + appearance.height > lastStory.y;
  expect(overlap, "Appearance must not cover story imagery").toBe(false);
  await page.screenshot({path:"test-results/ighor-home-1366x768-typography.png"});
});

test("Igor uses one navigation geometry and control system across primary pages", async ({page}) => {
  await page.setViewportSize({width:1448,height:1086});
  const snapshots: {view:string; width:number; items:string[]; radius:string}[] = [];
  for (const view of ["home","explore","create","saved","maps","conversations"]) {
    await page.goto(`/app?view=${view}`);
    const nav = page.getByRole("navigation",{name:"Product navigation"});
    await expect(nav).toBeVisible();
    const metrics = await page.evaluate(() => {
      const shell = document.querySelector(".iw-nav");
      const buttons = [...document.querySelectorAll(".iw-nav nav button")];
      return {
        width: shell?.getBoundingClientRect().width || 0,
        items: buttons.map((button)=>button.textContent?.trim() || ""),
        radius: buttons.length ? getComputedStyle(buttons[0]).borderRadius : "",
      };
    });
    snapshots.push({view,...metrics});
    expect(metrics.width).toBeGreaterThanOrEqual(202);
    expect(metrics.width).toBeLessThanOrEqual(208);
    expect(metrics.items).toEqual(["Home","Explore","Create","Library","Maps","Search"]);
  }
  expect(new Set(snapshots.map((value)=>value.radius)).size).toBe(1);
  console.log("IGOR_COHERENCE_NAV",JSON.stringify(snapshots));
});

test("Library stays right of the existing sidebar at desktop widths", async ({page}) => {
  await page.setViewportSize({width:1448,height:900});
  await page.goto("/app?view=saved");
  const sidebar=await page.locator(".iw-nav").boundingBox();
  const library=await page.locator(".ig-reference-library").boundingBox();
  expect(sidebar).not.toBeNull();
  expect(library).not.toBeNull();
  expect(library!.x).toBeGreaterThanOrEqual(sidebar!.x+sidebar!.width-1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.screenshot({path:"test-results/igor-pr31-fixed-library.png",fullPage:false});
});

test("App uses the rounded landing identity without changing PR31's home composition", async ({page}) => {
  await page.setViewportSize({width:1448,height:900});
  await page.goto("/app?view=home");
  const logo=page.locator(".iw-nav .iw-brand img");
  await expect(logo).toHaveAttribute("src","/marketing/assets/brand/igor-mark-black.svg");
  await expect(page.getByRole("heading",{name:/Your agent.*With taste/i})).toBeVisible();
  await expect(page.locator(".iw-story-card")).toHaveCount(5);
});
