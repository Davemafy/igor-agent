import { chromium } from "playwright";
import fs from "node:fs/promises";

const root = process.env.IGOR_VERIFY_BASE || "http://127.0.0.1:3570";
const directory = "test-results/live-general-research";
await fs.mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const report = {
  provenance: "LIVE general research; no fixtures, no Qloo requirement",
  passed: false,
};

try {
  const created = await page.request.post(`${root}/api/tasks`, {
    headers: { Origin: root },
  });

  if (!created.ok()) {
    throw Error("create_workspace_failed");
  }

  let task = await created.json();
  const id = task.id;
  await page.addInitScript((workspace) => {
    localStorage.setItem("igor-task", workspace);
  }, id);
  await page.goto(`${root}/app`);

  async function turn(text) {
    const response = await page.request.post(`${root}/api/tasks/${id}/turn`, {
      headers: { Origin: root },
      data: { type: "message", text, version: task.brief.version },
      timeout: 600000,
    });

    if (!response.ok()) {
      throw Error(`turn_http_${response.status()}`);
    }

    const events = (await response.text())
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    const done = events.findLast((event) => event.type === "done");

    if (!done) {
      throw Error("turn_incomplete");
    }

    task = done.task;
    await page.reload();

    return structuredClone(task);
  }

  const documents = (workspace) => [
    ...workspace.artifacts,
    ...(workspace.work?.documents ?? []).map((doc) => ({
      ...doc,
      id: `document:${doc.id}`,
    })),
  ];
  const summarize = (workspace) => ({
    status: workspace.agentRun?.status ?? workspace.status,
    acceptance: workspace.agentRun?.acceptance?.status ?? null,
    modelCalls: workspace.agentRun?.usage?.modelCalls ?? null,
    steps: (workspace.agentRun?.steps ?? []).map((step) => ({
      tool: step.tool,
      status: step.status,
      summary: step.summary.slice(0, 260),
    })),
    documents: documents(workspace).map((doc) => ({
      id: doc.id,
      title: doc.title,
      evidenceIds: doc.evidenceIds,
      fulfills: doc.fulfills ?? [],
      chars: doc.content.length,
    })),
    sourceCount: workspace.evidence.filter(
      (evidence) =>
        evidence.kind === "practical" &&
        evidence.source === "provider-returned" &&
        evidence.freshness === "current",
    ).length,
    culturalCalls: workspace.receipts?.at(-1)?.culturalRequests ?? null,
  });
  const first = await turn(
    "Research the electric vehicle charging market, compare major competitors " +
      "using current public sources, and save an editable investment memo " +
      "with evidence links, risks, uncertainties and assumptions.",
  );
  report.initial = summarize(first);
  const currentEvidenceIds = new Set(
    first.evidence
      .filter(
        (evidence) =>
          evidence.kind === "practical" &&
          evidence.source === "provider-returned" &&
          evidence.freshness === "current",
      )
      .map((evidence) => evidence.id),
  );
  const initialMemo = documents(first).find(
    (doc) =>
      doc.content.length > 250 &&
      doc.fulfills?.some((key) => /memo|report/i.test(key)) &&
      doc.evidenceIds.some((id) => currentEvidenceIds.has(id)),
  );
  const goodInitial = Boolean(initialMemo);

  if (
    !goodInitial ||
    first.agentRun?.acceptance?.status !== "satisfied" ||
    first.agentRun?.steps.some((step) => step.tool.startsWith("qloo.")) ||
    currentEvidenceIds.size === 0
  ) {
    throw Error("research_acceptance_unsatisfied");
  }

  const second = await turn(
    "Revise the saved investment memo to prioritize charging-network operators. " +
      "Keep the earlier research citations and clearly flag anything not verified.",
  );
  report.revision = summarize(second);
  const reloaded = await (
    await page.request.get(`${root}/api/tasks/${id}`)
  ).json();
  const retained =
    currentEvidenceIds.size > 0 &&
    [...currentEvidenceIds].every((evidenceId) =>
      reloaded.evidence.some((evidence) => evidence.id === evidenceId),
    );

  const updatedMemo = documents(reloaded).find(
    (doc) => doc.id === initialMemo?.id,
  );
  const originalCitations = new Set(initialMemo.evidenceIds);
  const citationsPreserved = Boolean(
    updatedMemo?.evidenceIds.some((id) => originalCitations.has(id)),
  );
  const actualRevision =
    Boolean(updatedMemo) &&
    updatedMemo.content !== initialMemo.content &&
    updatedMemo.content.length > 250 &&
    citationsPreserved &&
    updatedMemo.version > initialMemo.version;
  const revisionToolExecuted = (second.agentRun?.steps ?? []).some(
    (step) => step.tool === "document.revise" && step.status === "ok",
  );
  report.revisionVerified = {
    sameArtifact: updatedMemo?.id === initialMemo?.id,
    contentChanged: updatedMemo?.content !== initialMemo?.content,
    citationsPreserved,
    revisionToolExecuted,
  };
  report.passed =
    retained &&
    reloaded.id === first.id &&
    reloaded.brief.version > first.brief.version &&
    actualRevision &&
    revisionToolExecuted &&
    !second.agentRun?.steps.some((step) => step.tool.startsWith("qloo."));
} catch (error) {
  report.failure = String(error.message)
    .replace(/[^a-zA-Z0-9_ -]/g, "")
    .slice(0, 100);
} finally {
  await fs.writeFile(
    `${directory}/report.json`,
    JSON.stringify(report, null, 2),
  );
  console.log("LIVE_GENERAL_RESEARCH_REPORT", JSON.stringify(report));
  await context.close();
  await browser.close();
}

if (!report.passed) {
  process.exitCode = 1;
}
