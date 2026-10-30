import { chromium } from "playwright";
import fs from "node:fs/promises";
const root = process.env.IGOR_VERIFY_BASE || "http://127.0.0.1:3570";
await fs.mkdir("test-results/live-flagship", { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: {
    dir: "test-results/live-flagship",
    size: { width: 1440, height: 900 },
  },
});
const page = await context.newPage();
let report = {
  provenance: "LIVE attempt; never sample/recorded",
  passed: false,
};

try {
  const created = await page.request.post(root + "/api/tasks", {
    headers: { Origin: root },
  });

  if (!created.ok()) {
    throw Error("task_creation");
  }

  let task = await created.json();
  await page.addInitScript(
    (id) => localStorage.setItem("igor-task", id),
    task.id,
  );
  await page.goto(root + "/app");

  async function turn(text) {
    const response = await page.request.post(
      root + `/api/tasks/${task.id}/turn`,
      {
        headers: { Origin: root },
        data: {
          ...(typeof text === "string" ? { type: "message", text } : text),
          version: task.brief.version,
        },
        timeout: 600000,
      },
    );

    if (!response.ok()) {
      throw Error("turn_http_" + response.status());
    }

    const events = (await response.text())
      .split("\n\n")
      .filter((s) => s.startsWith("data: "))
      .map((s) => JSON.parse(s.slice(6)));
    const done = events.findLast((e) => e.type === "done");

    if (!done) {
      const problem = events.findLast((event) => event.type === "error");
      const terminalCode = String(problem?.code ?? "stream-ended")
        .replace(/[^a-z-]/g, "")
        .slice(0, 60);
      throw Error(`turn_${terminalCode}_after_${events.length}_events`);
    }

    task = done.task;
    await page.reload();
    await page.locator(".iw-composer").waitFor();
    await page.waitForTimeout(700);

    return structuredClone(task);
  }

  const documents = (t) => [
    ...t.artifacts,
    ...(t.work?.documents ?? []).map((d) => ({ ...d, id: `document:${d.id}` })),
  ];
  const diagnostic = (t) => ({
    status: t.agentRun?.status ?? t.status,
    acceptance: t.agentRun?.acceptance?.status ?? null,
    usage: t.agentRun?.usage ?? null,
    warnings: (t.agentRun?.warnings ?? [])
      .slice(-6)
      .map((value) => value.slice(0, 240)),
    resolvedEntities: t.entities
      .filter((e) => e.status === "resolved")
      .map(({ name, type, providerId }) => ({ name, type, providerId })),
    culturalEvidence: t.evidence
      .filter((e) => e.kind === "cultural")
      .map(({ id, delivery, freshness }) => ({ id, delivery, freshness })),
    savedDocuments: documents(t).map(({ id, title, content }) => ({
      id,
      title,
      characters: content.length,
    })),
    steps: (t.agentRun?.steps ?? []).map(
      ({ tool, status, requests, summary }) => ({
        tool,
        status,
        requests,
        summary: summary.slice(0, 600),
      }),
    ),
    failureCategories: t.trace
      .filter((e) => /error|rejected/.test(e.action))
      .map((e) => ({
        action: e.action,
        category: /^agent\.(decision|requirements)\.error$/.test(e.action)
          ? e.outcome
          : e.outcome
              .match(/Diagnostic: ([^.]+)|failed \(([^)]+)\)/)
              ?.slice(1)
              .filter(Boolean)
              .join(";") || "unclassified",
      })),
  });
  let first = await turn(
    "I run a 100-capacity space in Brooklyn. Our community loves Sade, Radiohead and Wong Kar-wai films. Design an unexpected Saturday experience, keep the proposed production budget under $3,000 and give me something I can pitch to partners. Save an editable proposal, provisional budget and schedule, and partner pitch. Label unverified practical facts.",
  );
  await page.screenshot({
    path: "test-results/live-flagship/01-proposal.png",
    fullPage: true,
  });
  report.initial = diagnostic(first);

  if (first.agentRun?.acceptance?.status !== "satisfied") {
    throw Error("initial_acceptance_unsatisfied");
  }

  // A real owner-authored independent constraint, explicitly saved and approved.
  // This is not model output or Qloo evidence.
  await turn({
    type: "work",
    actions: [
      ...(task.work?.activeGoalId
        ? []
        : [
            {
              kind: "goal",
              id: "flagship-experience",
              title: "Community experience",
            },
          ]),
      {
        kind: "document",
        id: "access-principle",
        title: "Access principle",
        content:
          "Owner requirement: keep step-free access as a venue-selection constraint. Verify accessibility with any proposed partner before committing.",
        dependencies: [],
        evidenceIds: [],
      },
    ],
  });
  first = await turn({
    type: "work",
    actions: [{ kind: "approve", id: "access-principle" }],
  });
  const second = await turn(
    "Replace Radiohead with Bad Bunny. Keep approved decisions and the $3,000 budget. Show me what changes and why, and save the revised proposal.",
  );
  await page.screenshot({
    path: "test-results/live-flagship/02-revision.png",
    fullPage: true,
  });
  await page.reload();
  const loaded = await (
    await page.request.get(root + `/api/tasks/${task.id}`)
  ).json();
  const cultural = (t) => t.evidence.filter((e) => e.kind === "cultural");
  const newEvidence = cultural(second).filter(
    (e) => !cultural(first).some((old) => old.id === e.id),
  );
  const approved = (first.work?.documents ?? []).filter(
    (a) => a.status === "approved",
  );
  const approvedPreserved = approved.every((a) =>
    (loaded.work?.documents ?? []).some(
      (b) =>
        b.id === a.id && b.content === a.content && b.status === "approved",
    ),
  );
  report.revision = diagnostic(second);
  const revised = documents(loaded).filter(
    (artifact) =>
      second.agentRun?.outputArtifactIds?.includes(artifact.id) &&
      documents(first).some(
        (old) => old.id === artifact.id && old.content !== artifact.content,
      ),
  );
  const historyRetained =
    revised.length > 0 &&
    revised.every((artifact) =>
      documents(first).some(
        (old) =>
          old.id === artifact.id &&
          (loaded.artifactHistory?.some(
            (entry) =>
              entry.artifact.id === old.id &&
              entry.artifact.content === old.content,
          ) ||
            loaded.work?.documents.some(
              (d) =>
                `document:${d.id}` === old.id &&
                d.history.some((h) => h.content === old.content),
            )),
      ),
    );
  await fs.writeFile(
    "test-results/live-flagship/documents.json",
    JSON.stringify(
      {
        initial: first.artifacts,
        current: loaded.artifacts,
        history: loaded.artifactHistory ?? [],
      },
      null,
      2,
    ),
  );
  report = {
    ...report,
    historyRetained,
    revisedDocumentCount: revised.length,
    firstRunId: first.agentRun?.id,
    revisionRunId: second.agentRun?.id,
    firstStatus: first.agentRun?.status ?? first.status,
    firstRun: first.agentRun
      ? {
          warnings: first.agentRun.warnings,
          usage: first.agentRun.usage,
          steps: first.agentRun.steps.map(
            ({ tool, status, requests, summary }) => ({
              tool,
              status,
              requests,
              summary: summary.slice(0, 180),
            }),
          ),
          acceptance: first.agentRun.acceptance?.status,
        }
      : null,
    revisionRun: second.agentRun
      ? {
          warnings: second.agentRun.warnings,
          usage: second.agentRun.usage,
          steps: second.agentRun.steps.map(
            ({ tool, status, requests, summary }) => ({
              tool,
              status,
              requests,
              summary: summary.slice(0, 180),
            }),
          ),
          acceptance: second.agentRun.acceptance?.status,
        }
      : null,
    diagnostics: second.trace
      .filter((t) => /error|recovered|rejected/.test(t.action))
      .map((t) => ({
        action: t.action,
        category: /^agent\.(decision|requirements)\.error$/.test(t.action)
          ? t.outcome
          : t.outcome
              .match(/Diagnostic: ([^.]+)|failed \(([^)]+)\)/)
              ?.slice(1)
              .filter(Boolean)
              .join(";") || "unclassified",
      })),
    revisionStatus: second.agentRun?.status ?? second.status,
    firstCulturalEvidence: cultural(first).length,
    liveCulturalEvidence: cultural(first).filter((e) => e.delivery === "LIVE")
      .length,
    cachedCulturalEvidence: cultural(first).filter(
      (e) => e.delivery === "CACHED",
    ).length,
    newCulturalEvidence: newEvidence.length,
    newLiveCulturalEvidence: newEvidence.filter((e) => e.delivery === "LIVE")
      .length,
    newCachedCulturalEvidence: newEvidence.filter(
      (e) => e.delivery === "CACHED",
    ).length,
    firstArtifacts: documents(first).length,
    revisionArtifacts: documents(second).length,
    budgetRetained: loaded.brief.constraints.budget === 3000,
    reloadStable:
      JSON.stringify(documents(loaded)) === JSON.stringify(documents(second)),
    approvedCount: approved.length,
    approvedPreserved,
  };
  const compared = await turn({ type: "baseline" });
  report.samePoolEvaluation = compared.evaluation ?? null;
  report.passed =
    first.agentRun?.acceptance?.status === "satisfied" &&
    second.agentRun?.acceptance?.status === "satisfied" &&
    report.liveCulturalEvidence > 0 &&
    report.newLiveCulturalEvidence > 0 &&
    report.budgetRetained &&
    report.reloadStable &&
    historyRetained &&
    first.agentRun?.id !== second.agentRun?.id &&
    approved.length > 0 &&
    approvedPreserved;
} catch (error) {
  report.failure = String(error.message)
    .replace(/[^a-zA-Z0-9_ -]/g, "")
    .slice(0, 100);
} finally {
  await fs.writeFile(
    "test-results/live-flagship/report.json",
    JSON.stringify(report, null, 2),
  );
  console.log("LIVE_FLAGSHIP_REPORT", JSON.stringify(report));
  await context.close();
  await browser.close();
}

if (!report.passed) {
  process.exitCode = 1;
}
