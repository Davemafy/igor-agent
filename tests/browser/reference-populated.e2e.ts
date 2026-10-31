import { expect, test, type Page } from "@playwright/test";
import { freshTask, sampleCatalogue } from "../../src/data/fixtures";

type VisualTask = ReturnType<typeof freshTask>;

async function serveTask(page: Page, task: VisualTask) {
  await page.route(`**/api/tasks/${task.id}`, async (route) => {
    if (route.request().method() !== "GET") { return route.continue(); }

    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(task),
    });
  });
}

function gatheringFixture(): VisualTask {
  const task = freshTask("visual-gathering", "fixture-owner");
  task.status = "ready";
  task.brief.goal = "A film and music evening";
  task.brief.constraints.location = "New York";
  task.catalogue = sampleCatalogue().slice(0, 4).map((candidate) => ({
    ...candidate, sample: false,
  }));
  task.brief.selected = task.catalogue.map((item) => item.id);
  task.schedule = [
    {label: "Dinner",minutes:60,candidateId:"moonrise"},
    {label: "Film",minutes:94,candidateId:"moonrise"},
    {label: "Music",minutes:40,candidateId:"arrival"},
  ];
  task.messages = [
    {role:"user",text:"Plan a film evening for six friends.",at:"2026-10-30T10:00:00Z"},
    {role:"assistant",text:"Here are some options, with their source limitations.",at:"2026-10-30T10:00:01Z"},
  ];
  task.artifacts.push({
    id:"invitation",kind:"invitation",title:"An evening together",
    content:"Dinner and film with friends",version:1,
    dependencies:[],evidenceIds:[],assumptions:[],freshness:"current",edited:false,
  });

  return task;
}

function researchFixture(): VisualTask {
  const task = freshTask("visual-research", "fixture-owner");
  task.status = "ready";
  task.brief.kind = "discovery";
  task.brief.goal = "Rooftop places and their tradeoffs";
  task.artifacts.push({
    id:"report",kind:"research-report",title:"New York rooftop research",
    content:"# Overview\nA structured research brief considering practical tradeoffs, costs, accessibility, and the strength of available sources.",
    version:1,dependencies:[],evidenceIds:[],assumptions:[],freshness:"current",edited:false,
  });
  task.messages.push({
    role:"user",text:"Compare New York rooftop venues.",at:"2026-10-30T10:00:00Z",
  });

  return task;
}

test("non-event research opens a real document layout, never an invitation", async ({page}) => {
  await page.setViewportSize({width:1448,height:1086});
  const task = researchFixture();
  await serveTask(page,task);
  await page.goto(`/app?task=${task.id}&view=create`);
  await expect(page.locator(".ig-create-stage-document")).toBeVisible();
  await expect(page.getByRole("heading",{name:"New York rooftop research"}).first()).toBeVisible();
  await expect(page.locator(".ig-create-collage")).toHaveCount(0);
  await expect(page.getByRole("button",{name:/Create invite/i})).toHaveCount(0);
  await page.screenshot({path:"test-results/ighor-populated-research-create.png"});
});

test("a populated fixture must render Conversation, Plan, Compare, Details, and invitation", async ({page}) => {
  await page.setViewportSize({width:1448,height:1086});
  const task = gatheringFixture();
  await serveTask(page,task);

  await page.goto(`/app?task=${task.id}&view=conversation`);
  await expect(page.getByText("Plan a film evening for six friends.")).toBeVisible();
  await expect(page.getByText("Here are some options, with their source limitations.")).toBeVisible();
  await page.screenshot({path:"test-results/ighor-populated-conversation.png"});

  await page.goto(`/app?task=${task.id}&view=plan`);
  await expect(page.locator(".ir-plan-timeline li")).toHaveCount(3);
  await page.screenshot({path:"test-results/ighor-populated-plan.png"});

  await page.goto(`/app?task=${task.id}&view=compare`);
  await expect(page.locator(".ir-matrix-column")).toHaveCount(4);
  await page.screenshot({path:"test-results/ighor-populated-compare.png"});

  await page.goto(`/app?task=${task.id}&view=detail`);
  await expect(page.locator(".ir-detail-hero")).toBeVisible();
  await page.screenshot({path:"test-results/ighor-populated-detail.png"});

  await page.goto(`/app?task=${task.id}&view=create`);
  await expect(page.locator(".ig-create-stage-grounded")).toBeVisible();
  await expect(page.getByRole("button",{name:"Open work"})).toBeVisible();
  await expect(page.locator(".ig-create-photo img[src*='create-film-portrait']")).toHaveCount(0);
  await expect(page.locator(".ig-create-photo img[src*='plan-editorial-cover']")).toHaveCount(0);
  await page.screenshot({path:"test-results/ighor-populated-invitation.png"});
});

test("verified geocoded places render an actual map surface without an engine-generated spatial node", async ({page}) => {
  const task = freshTask("visual-map-verified", "fixture-owner");
  const seed = sampleCatalogue()[0];
  task.catalogue = [{
    ...seed,
    id: "verified-nyc-place",
    providerId: "qloo:place:verified-nyc-place",
    type: "place",
    name: "Verified Manhattan location",
    description: "Fixture place used for validating coordinate-based rendering.",
    sample: false,
    location: "New York",
    place: {
      latitude: 40.7128,
      longitude: -74.0060,
      address: "Manhattan, New York",
      website: null,
      locality: null,
    },
  }];
  task.canvas = undefined;

  await serveTask(page, task);
  await page.goto(`/app?task=${task.id}&view=maps`);
  const map = page.getByRole("region",{name:"Interactive location map"});
  await expect(map).toBeVisible();
  await expect(map.getByText("1 verified place in this conversation")).toBeVisible();
  await map.getByRole("button",{name:"Verified Manhattan location"}).click();
  const frame = map.locator("iframe");
  await expect.poll(async()=>frame.getAttribute("src")).toContain("marker=");
  await expect(page.getByRole("button",{name:"3D / advanced"})).toBeVisible();
  await map.getByRole("button",{name:/Details for Verified Manhattan location/}).click();
  await expect(page).toHaveURL(/view=detail/);
  await expect(page.locator(".ir-detail")).toContainText("Verified Manhattan location");
  await page.screenshot({path:"test-results/igor-verified-geocoded-map-fixture.png",fullPage:false});
});

test("Conversation and Your work are one coherent, full-width task without losing the transcript", async ({ page }) => {
  await page.setViewportSize({width:1448,height:1086});
  const task = gatheringFixture();
  await serveTask(page,task);
  await page.goto(`/app?task=${task.id}&view=conversation`);

  const workspace = page.locator(".iw-inline-workspace");
  const conversation = page.getByRole("button",{name:"Conversation",exact:true});
  const work = page.getByRole("button",{name:"Your work",exact:true});
  await expect(conversation).toHaveAttribute("aria-pressed","true");
  await expect(page.getByText("Plan a film evening for six friends.")).toBeVisible();
  await expect(page.locator(".iw-thread")).toBeVisible();
  await expect(page.locator(".iw-inline-output")).toBeHidden();
  const grid = await page.locator(".iw-workgrid").boundingBox();
  const thread = await page.locator(".iw-thread").boundingBox();
  console.log("IGOR_COHERENCE_WORKSPACE", JSON.stringify({grid,thread}));
  expect(grid).not.toBeNull();
  expect(thread).not.toBeNull();
  expect(thread!.width).toBeGreaterThan(grid!.width * .94);

  await work.click();
  await expect(workspace).toHaveAttribute("data-pane","work");
  await expect(page.locator(".iw-inline-output")).toBeVisible();
  await expect(page.locator(".iw-thread")).toBeHidden();
  await page.screenshot({path:"test-results/igor-coherent-work-1448.png"});

  await conversation.click();
  await expect(workspace).toHaveAttribute("data-pane","thread");
  await expect(page.getByText("Plan a film evening for six friends.")).toBeVisible();
  await expect(page.locator(".iw-inline-output")).toBeHidden();
  await page.screenshot({path:"test-results/igor-coherent-conversation-1448.png"});
});

test("Mobile Conversation and Work switching preserves one task", async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const task = gatheringFixture();
  await serveTask(page,task);
  await page.goto(`/app?task=${task.id}&view=conversation`);
  await page.getByRole("button",{name:"Your work",exact:true}).click();
  await expect(page.locator(".iw-inline-output")).toBeVisible();
  await page.getByRole("button",{name:"Conversation",exact:true}).click();
  await expect(page.getByText("Plan a film evening for six friends.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.screenshot({path:"test-results/igor-coherent-conversation-mobile.png"});
});

test("unsaved gathering never presents the user prompt as a completed artifact", async ({page}) => {
  await page.setViewportSize({width:1448,height:1086});
  const task=freshTask("create-without-artifact","fixture-owner");
  task.status="partial";
  task.brief.kind="gathering";
  task.brief.goal="WE ARE SIX FRIENDS IN BROOKLYN AND LOVE SADE RADIOHEAD AND WONG KAR-WAI. RESEARCH QLOO-BACKED MUSIC AND FILMS THEN MAKE AN EDITABLE PROPOSAL WITHOUT INVENTED PRICES.";
  task.artifacts=[];
  task.messages.push({role:"user",text:task.brief.goal,at:"2026-10-30T10:00:00Z"});
  await serveTask(page,task);
  await page.goto(`/app?task=${task.id}&view=create`);
  const stage=page.getByRole("region",{name:"Connected creation preview"});
  await expect(stage).toBeVisible();
  await expect(stage.getByRole("heading",{name:"Create from this conversation"})).toBeVisible();
  await expect(stage.getByText(/No saved document or invitation is ready yet/)).toBeVisible();
  await expect(stage.getByRole("button",{name:"Generate editable draft"})).toBeVisible();
  await expect(page.locator(".ig-create-collage")).toHaveCount(0);
  await expect(page.locator(".ig-create-document-paper")).toHaveCount(0);
  await expect(page.locator(".ig-create-empty-main h2")).toHaveText("Turn this conversation into something you can use.");
  await page.screenshot({path:"test-results/igor-create-no-artifact-honest.png",fullPage:false});
});

test("discovery gives factual coverage and explicit missing-music action", async ({page}) => {
  await page.setViewportSize({width:1448,height:1086});
  const task=freshTask("film-music-coverage","fixture-owner");
  task.status="partial";
  task.brief.goal="Plan a film and music evening with friends";
  task.catalogue=sampleCatalogue().filter(c=>c.type==="movie"||c.type==="tv_show").slice(0,2)
    .map(c=>({...c,sample:false}));
  await serveTask(page,task);
  await page.goto(`/app?task=${task.id}&view=explore`);
  const discovery=page.locator(".ir-discover");
  await expect(discovery).toBeVisible();
  await expect(discovery.getByText(/0 music/)).toBeVisible();
  await expect(discovery.getByRole("button",{name:/Find missing music options/})).toBeVisible();
  await expect(discovery.locator(".ir-card-proof").first()).toBeVisible();
});

test("Qloo query rank, affinity and seed stay attached to the result across Explore, Compare and Details", async ({page}) => {
  await page.setViewportSize({width:1448,height:1086});
  const task=freshTask("qloo-evidence-visible","fixture-owner");
  task.mode="qloo-live";
  task.brief.participants=[];
  task.status="partial";
  task.brief.goal="Find a thoughtful film for friends";
  task.catalogue=[{
    ...sampleCatalogue()[0],
    id:"qloo-evidence-film",providerId:"qloo:film:evidence-test",sample:false,
    name:"Film from provider",
    cultural:{context:{
      signalScope:"context",rank:2,affinity:0.82,
      queryId:"qloo-query-abc",seedIds:["seed-42"],
      explanationScope:"none",explanationEntities:[],
      delivery:"LIVE",retrievedAt:"2026-10-30T10:00:00Z",
    }},
  }];
  await serveTask(page,task);
  await page.goto(`/app?task=${task.id}&view=explore`);
  const proof=page.locator(".ir-card-proof");
  await expect(proof).toContainText("Qloo · LIVE");
  await expect(proof).toContainText("Rank #2");
  await expect(proof).toContainText("raw affinity 0.82");
  await expect(proof).toContainText("seed-42");

  await page.goto(`/app?task=${task.id}&view=compare`);
  await expect(page.locator(".ir-compare-context-signal")).toContainText("Qloo LIVE · Rank #2");
  await expect(page.locator(".ir-compare-context-signal")).toContainText("seed-42");

  await page.goto(`/app?task=${task.id}&view=detail`);
  await expect(page.locator(".ir-detail-signal-summary")).toContainText("Qloo LIVE");
  await expect(page.locator(".ir-signals")).toContainText("Rank #2");
  await page.screenshot({path:"test-results/igor-real-qloo-field-presentation-fixture.png",fullPage:false});
});
