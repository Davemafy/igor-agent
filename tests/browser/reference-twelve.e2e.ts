import { expect, test } from "@playwright/test";

/**
 * Empty-state route smoke only. These captures MUST NEVER be used as proof
 * that a populated owner reference was reconstructed. Populated composition
 * is verified separately by reference-populated.e2e.ts. Map provider/live
 * behavior requires another test and is not simulated here.
 */
const desktopViews = [
  {view:"home", selector:".iw-welcome",name:"01-home"},
  {view:"explore", selector:".ir-discover",name:"02-discover"},
  {view:"conversation", selector:".iw-app",name:"03-unpopulated-conversation"},
  {view:"plan", selector:".ir-plan",name:"04-plan"},
  {view:"maps", selector:".ir-maps",name:"05-maps-2d"},
  {view:"create", selector:".ig-create-stage-grounded",name:"07-create"},
  {view:"compare", selector:".ir-compare",name:"08-compare"},
  {view:"saved", selector:".ig-reference-library",name:"09-library"},
  {view:"detail", selector:".ir-detail",name:"10-detail"},
  {view:"revisions", selector:".ir-revisions",name:"11-revisions"},
] as const;

test("Empty-state desktop routes do not overflow; this is not a visual fidelity test", async ({page}) => {
  await page.setViewportSize({width:1448,height:1086});
  for (const item of desktopViews) {
    await page.goto(`/app?view=${item.view}`);
    await expect(page.locator(item.selector).first()).toBeVisible();
    await expect(page.getByRole("navigation",{name:"Product navigation"})).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow, `${item.name} must not overflow the viewport`).toBe(false);
    await page.screenshot({path:`test-results/ighor-route-smoke-${item.name}-desktop.png`,fullPage:false});
  }
});

test("Empty-state mobile routes preserve navigation without claiming content coverage", async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const views = [
    {view:"home",name:"12-home"},
    {view:"explore",name:"12-discover"},
    {view:"plan",name:"12-plan"},
    {view:"maps",name:"12-map"},
    {view:"create",name:"12-create"},
    {view:"compare",name:"12-compare"},
  ];
  for (const item of views) {
    await page.goto(`/app?view=${item.view}`);
    await expect(page.getByRole("navigation",{name:"Product navigation"})).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow, `${item.name} must not overflow the viewport`).toBe(false);
    await page.screenshot({path:`test-results/ighor-route-smoke-${item.name}-mobile.png`,fullPage:false});
  }
});

test("Maps opens an interactive geographic view even without verified task places", async ({page}) => {
  await page.setViewportSize({width:1448,height:900});
  await page.goto("/app?view=maps");
  const map = page.getByRole("region",{name:"Interactive location map"});
  await expect(map).toBeVisible();
  const frame=map.locator('iframe[title^="Interactive OpenStreetMap"]');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute("src",/openstreetmap\.org\/export\/embed\.html/);
  const first=await frame.getAttribute("src");
  expect(first).not.toContain("marker=");
  await map.getByRole("button",{name:"Tokyo",exact:true}).click();
  await expect(map.getByText("Tokyo map view · no suggested pins")).toBeVisible();
  expect(await frame.getAttribute("src")).not.toBe(first);
  expect(await frame.getAttribute("src")).not.toContain("marker=");
  await page.screenshot({path:"test-results/ighor-real-map-desktop.png"});
});


test("capture real map rendering after iframe assets have settled", async ({page}) => {
  await page.setViewportSize({width:1448,height:900});
  await page.goto("/app?view=maps");
  const map=page.locator('.ir-grounded-map-frame');
  await expect(map).toBeVisible();
  const iframe=map.locator("iframe");
  await expect(iframe).toHaveAttribute("src",/openstreetmap\.org\/export\/embed\.html/);
  await page.waitForTimeout(6000);
  const current=page.frames().find((frame)=>frame.url().includes("openstreetmap.org/export/embed.html"));
  let diagnostic={frame:current?.url() || "none",loadedImages:0,canvasCount:0,bodyChars:0};
  if (current) {
    try {
      const details=await current.evaluate(()=>({
        loadedImages:Array.from(document.querySelectorAll("img"))
          .filter((img)=>img instanceof HTMLImageElement && img.complete && img.naturalWidth>0).length,
        canvasCount:document.querySelectorAll("canvas").length,
        bodyChars:document.body?.innerText.length ?? 0,
      }));
      diagnostic={frame:current.url(),...details};
    } catch {/* Frame may navigate during task restoration; screenshot still documents output. */}
  }
  console.log("IGOR_MAP_RENDER_DIAGNOSTIC",JSON.stringify(diagnostic));
  await page.screenshot({path:"test-results/ighor-loaded-map-visual-review.png",fullPage:false});
});