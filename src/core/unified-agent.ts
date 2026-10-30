import { recordArtifactChanges } from "./preserve-artifacts";
import { applyConversationActions } from "./conversation";
import { invalidate } from "./revision";
import { z } from "zod";
import { applyWorkActions } from "./connected-work";
import { agentStepLimit } from "../tools/model-budget";
import { interpretationFailure } from "./interpretation-failure";
import {
  AgentRequirementsSchema,
  type AgentRequirements,
  verifyAgentOutcome,
} from "./agent-acceptance";
import { randomUUID } from "node:crypto";
import type { Task, Event } from "./contracts";
import { TaskSchema } from "./contracts";
import type { TaskStore } from "../data/store";
import type { ModelProvider, CulturalProvider } from "../tools/interfaces";
import type {
  ResearchProvider,
  ResearchResult,
  ResearchSource,
} from "../tools/live-research";
import type { GooglePlacesProvider } from "../tools/google-maps";
import type { BrowserbaseObserver } from "../tools/browserbase-observer";
import { withToolDeadline } from "./execution";
import {
  createAgentToolRegistry,
  type AgentToolContext,
} from "./agent-tool-registry";

export interface UnifiedAgentInput {
  task: Task;
  owner: string;
  store: TaskStore;
  goal: string;
  model: ModelProvider;
  requirements?: AgentRequirements;
  research: ResearchProvider;
  cultural?: CulturalProvider;
  places?: Pick<GooglePlacesProvider, "search">;
  browser?: Pick<BrowserbaseObserver, "observe">;
  send?: (event: Event) => void;
  trace: (
    action: string,
    outcome: string,
    requests?: number,
    evidenceIds?: string[],
  ) => void;
}

/** Observe → select validated tool → execute → checkpoint → observe, across
 * web, Qloo, Places and internal artifacts in one existing Task record. */
export async function runUnifiedAgent(
  input: UnifiedAgentInput,
): Promise<ResearchResult> {
  const { task, store, owner, model, trace } = input;

  if (!model.chooseAgentAction) {
    return {
      status: "blocked",
      sources: [],
      requests: 0,
      warning: "Configured model cannot select agent tools.",
    };
  }

  const clamp = (name: string, fallback: number, max: number) => {
    const value = Number(process.env[name]);

    return Number.isInteger(value) && value >= 1
      ? Math.min(max, value)
      : fallback;
  };

  const maxSteps = agentStepLimit();
  const callsBefore = model.calls ?? 0;
  const decisionDeadline = Math.max(
    18000,
    Math.min(120000, model.timeoutMs ?? 18000),
  );
  const maxRequests = clamp("IGOR_AGENT_MAX_REQUESTS", 8, 40);
  const runId = randomUUID();
  const now = () => new Date().toISOString();
  const sources: ResearchSource[] = [];
  const ctx: AgentToolContext = {
    task,
    research: input.research,
    cultural: input.cultural,
    places: input.places,
    browser: input.browser,
    sources,
    runId,
  };
  const tools = createAgentToolRegistry(ctx);

  if (task.agentRun) {
    const previous = task.agentRun;
    const finalStatus = [
      "completed",
      "partially_completed",
      "failed",
      "interrupted",
      "cancelled",
    ].includes(previous.status)
      ? previous.status
      : "interrupted";
    const savedArtifactIds = task.artifacts
      .filter((artifact) => artifact.id.startsWith(`agent-doc-${previous.id}`))
      .slice(-12)
      .map((artifact) => artifact.id);
    task.agentRunHistory = [
      ...(task.agentRunHistory ?? []),
      {
        id: previous.id,
        goal: previous.goal,
        status: finalStatus as typeof previous.status,
        startedAt: previous.startedAt,
        archivedAt: now(),
        requests: previous.requests,
        modelSteps: previous.modelSteps,
        toolNames: previous.steps.map((step) => step.tool),
        sourceCount: previous.sources.length,
        savedArtifactIds,
      },
    ].slice(-12);
  }

  task.agentRun = {
    id: runId,
    goal: input.goal.slice(0, 3000),
    status: "created",
    startedAt: now(),
    updatedAt: now(),
    maxSteps,
    maxRequests,
    requests: 0,
    modelSteps: 0,
    usage: {
      modelCalls: 0,
      providerRequests: 0,
      modelTokens: null,
      estimatedCostUsd: null,
    },
    steps: [],
    sources: [],
    warnings: [],
  };

  const persist = () => {
    const expected = task.brief.version;
    task.brief.version++;
    task.agentRun!.updatedAt = now();

    if (task.agentRun!.usage) {
      task.agentRun!.usage.modelCalls = Math.max(
        0,
        (model.calls ?? callsBefore) - callsBefore,
      );
      task.agentRun!.usage.providerRequests = task.agentRun!.requests;
    }

    TaskSchema.parse(task);
    // A newer user correction wins over any late external observation.
    store.save(task, expected, owner);
    input.send?.({ type: "state", task: structuredClone(task) });
  };

  const attempted = new Set<string>();
  let modelFinished = false;
  let decisionFailed = false;
  let argumentRepairs = 0;
  let finishRepairs = 0;
  task.agentRun.status = "reasoning";

  try {
    if (input.requirements) {
      task.agentRun.requirements = AgentRequirementsSchema.parse(
        input.requirements,
      );
    } else if (model.interpretAgentRequirements) {
      task.agentRun.modelSteps++;
      task.agentRun.requirements = AgentRequirementsSchema.parse(
        await withToolDeadline(
          model.interpretAgentRequirements(input.goal, structuredClone(task)),
          decisionDeadline,
        ),
      );
    }

    const budget = task.agentRun.requirements?.budget;

    if (budget) {
      const userTexts = [
        input.goal,
        ...task.messages.filter((m) => m.role === "user").map((m) => m.text),
      ];

      if (!userTexts.some((text) => text.includes(budget.sourceText))) {
        throw new Error("Unbound budget source");
      }

      // Validate even an unchanged budget, without dirtying approved dependents.
      applyWorkActions(
        structuredClone(task),
        [{ kind: "budget", amount: budget.amount }],
        budget.sourceText,
      );

      if (
        task.brief.constraints.budget !== budget.amount ||
        task.work?.budget?.amount !== budget.amount ||
        !task.work.budget.confirmed
      ) {
        applyWorkActions(
          task,
          [{ kind: "budget", amount: budget.amount }],
          budget.sourceText,
        );
      }
    }

    const location = task.agentRun.requirements?.location;

    if (location) {
      const userTexts = [
        input.goal,
        ...task.messages.filter((m) => m.role === "user").map((m) => m.text),
      ];

      if (!userTexts.some((text) => text.includes(location.sourceText))) {
        throw new Error("Unbound location source");
      }

      const correction = applyConversationActions(
        task,
        [{ kind: "constraints", location: location.value }],
        location.sourceText,
      );

      if (!correction.ok) {
        throw new Error("Ungrounded location");
      }

      task.brief.constraints = correction.task.brief.constraints;

      if (correction.changed.length) {
        invalidate(task, correction.changed);
      }
    }

    if (!task.brief.goal) {
      task.brief.goal = input.goal;
    }
  } catch (error) {
    task.agentRun.requirements = undefined;
    trace("agent.requirements.error", interpretationFailure(error));
    task.agentRun.warnings.push(
      "Could not interpret acceptance requirements; completion remains unverified.",
    );
  }

  persist();

  for (let index = 0; index < maxSteps; index++) {
    const run = task.agentRun;

    if (!run) {
      break;
    }

    const readsExhausted = run.requests >= maxRequests;

    if (
      readsExhausted &&
      !run.warnings.includes(
        "Paid request limit reached; internal saving and critique remain available.",
      )
    ) {
      run.warnings.push(
        "Paid request limit reached; internal saving and critique remain available.",
      );
    }

    const references = run.requirements?.culturalReferences ?? [];
    const observedSeeds = new Set(
      task.catalogue.flatMap((candidate) =>
        Object.values(candidate.cultural ?? {}).flatMap(
          (signal) => signal.seedIds,
        ),
      ),
    );
    const culturalReady = references.length
      ? references.every((name) => {
          const entity = task.entities.find(
            (entity) =>
              entity.status === "resolved" &&
              entity.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
          );

          return Boolean(
            entity?.providerId && observedSeeds.has(entity.providerId),
          );
        })
      : observedSeeds.size > 0;
    const discoveryFailed = run.steps.some(
      (step) =>
        step.tool === "qloo.discover" &&
        (step.status === "blocked" || step.status === "error"),
    );
    const waitingForCulture =
      run.requirements?.culturalDecision && !culturalReady && !discoveryFailed;

    const available = tools.filter(
      (t) =>
        t.available &&
        (!readsExhausted || t.permission === "internal") &&
        (t.permission === "read" || t.permission === "internal") &&
        !(
          waitingForCulture &&
          ["document.create", "experience.compose"].includes(t.name)
        ),
    );
    let selection: Awaited<
      ReturnType<NonNullable<ModelProvider["chooseAgentAction"]>>
    >;

    try {
      run.modelSteps++;
      selection = await withToolDeadline(
        model.chooseAgentAction(
          input.goal,
          available.map((t) => ({
            name: t.name,
            description: t.description,
            permission: t.permission,
            inputSchema: z.toJSONSchema(t.schema),
          })),
          run.steps.map((s) => ({
            tool: s.tool,
            status: s.status,
            summary: s.summary,
          })),
          structuredClone(task),
        ),
        decisionDeadline,
      );
    } catch (error) {
      decisionFailed = true;
      run.warnings.push(
        "Agent decision provider failed; completed observations are preserved.",
      );
      trace("agent.decision.error", interpretationFailure(error));
      break;
    }

    const selected = available.find(
      (t) => t.name === selection.name && t.available,
    );

    if (!selected) {
      run.warnings.push("Model proposed an unavailable tool.");
      trace("agent.action.blocked", "Unavailable tool was rejected.");
      break;
    }

    if (selected.name === "agent.finish") {
      const acceptance = verifyAgentOutcome(task, input.goal, true);
      const obligations = run.requirements;
      const paidFailure = run.steps.some(
        (step) =>
          step.requests > 0 &&
          (step.status === "blocked" || step.status === "error"),
      );

      if (
        acceptance.status !== "satisfied" &&
        obligations &&
        (obligations.culturalDecision || obligations.deliverables.length > 0) &&
        !paidFailure &&
        finishRepairs++ < 2
      ) {
        const missing = acceptance.checks
          .filter((check) => check.status !== "satisfied")
          .map((check) => check.requirement)
          .join("; ");
        run.steps.push({
          id: randomUUID(),
          tool: "agent.finish",
          status: "blocked",
          requests: 0,
          summary:
            `Completion is not verified: ${missing}. Continue with authorized tools; resolved seeds alone are not cultural discovery, and requested deliverables must be saved.`.slice(
              0,
              600,
            ),
          at: now(),
          durationMs: 0,
        });
        trace(
          "agent.finish.blocked",
          "Unmet acceptance requirements returned to the bounded agent loop.",
        );
        persist();
        continue;
      }

      modelFinished = true;
      trace(
        "agent.finish",
        "Agent ended tool use after reviewing observed results.",
      );
      break;
    }

    let args: unknown;

    try {
      args = selected.schema.parse(selection.arguments);
    } catch {
      run.warnings.push(`Invalid arguments for ${selected.name}`);
      trace(
        "agent.action.blocked",
        "Tool argument schema rejected the proposal; no tool executed.",
      );

      if (argumentRepairs++ === 0) {
        run.steps.push({
          id: randomUUID(),
          tool: selected.name,
          status: "blocked",
          requests: 0,
          summary:
            "Arguments rejected before execution. Correct the arguments using this tool's declared inputSchema. No tool was executed.",
          at: now(),
          durationMs: 0,
        });
        persist();
        continue;
      }

      break;
    }

    const fingerprint = selected.name + ":" + JSON.stringify(args);

    if (attempted.has(fingerprint)) {
      run.warnings.push("Repeated tool invocation rejected.");
      trace("agent.action.blocked", "A duplicate tool call was blocked.");
      break;
    }

    attempted.add(fingerprint);
    run.status = "executing_tool";
    trace(
      "tool.invoke:" + selected.name,
      `Agent selected ${selected.name}; server validated permissions and arguments.`,
    );
    // Committing a pending step before waiting makes restart or dropped streams
    // visible. Read-only tools can be retried on a fresh user turn.
    persist();

    const start = Date.now();
    // A provider promise can settle after our deadline. Tools execute against
    // an isolated working copy; late results cannot mutate committed work.
    const workingTask = structuredClone(task);
    const workingSources = structuredClone(sources);
    const workingContext = {
      ...ctx,
      task: workingTask,
      sources: workingSources,
    };
    let outcome: Awaited<ReturnType<typeof selected.execute>>;

    try {
      outcome = await withToolDeadline(
        selected.execute(args, workingContext),
        17000,
      );

      if (outcome.status === "ok" || outcome.status === "partial") {
        recordArtifactChanges(workingTask, structuredClone(task.artifacts));
        task.artifactHistory = workingTask.artifactHistory;
        task.entities = workingTask.entities;
        task.catalogue = workingTask.catalogue;
        task.candidates = workingTask.candidates;
        task.evidence = workingTask.evidence;
        task.artifacts = workingTask.artifacts;
        task.trueforgeSessionId = workingTask.trueforgeSessionId;
        task.work = workingTask.work;
        task.brief.constraints = workingTask.brief.constraints;
        sources.splice(0, sources.length, ...workingSources);
      }
    } catch {
      outcome = {
        status: "error",
        summary:
          "Tool execution failed or timed out; no late mutation was accepted.",
        // Conservatively reserve a request for potentially in-flight paid I/O.
        requests: selected.permission === "internal" ? 0 : 1,
      };
    }

    run.outputArtifactIds = [
      ...new Set([
        ...(run.outputArtifactIds ?? []),
        ...(outcome.artifactIds ?? []),
      ]),
    ].slice(-12);
    run.culturalSeedIds = [
      ...new Set([
        ...(run.culturalSeedIds ?? []),
        ...(outcome.culturalSeedIds ?? []),
      ]),
    ].slice(-12);
    run.requests += outcome.requests;
    run.steps.push({
      id: randomUUID(),
      tool: selected.name,
      status: outcome.status,
      requests: outcome.requests,
      summary: outcome.summary.slice(0, 600),
      at: now(),
      durationMs: Date.now() - start,
    });

    for (const source of sources) {
      const evidenceId = `${task.id}:agent:${runId}:${source.id}`;

      if (!task.evidence.some((e) => e.id === evidenceId)) {
        task.evidence.push({
          id: evidenceId,
          source: "provider-returned",
          kind: "practical",
          at: source.retrievedAt,
          reference: source.url,
          title: source.title,
          ...(source.imageUrl ? { previewImageUrl: source.imageUrl } : {}),
          entityIds: [],
          summary: `${source.title}: ${(source.excerpt ?? source.snippet).slice(0, 1100)}`,
          limitations: [
            source.excerpt
              ? "Provider page text, not independently verified."
              : "Returned search/Places/Qloo source lead; page was not opened.",
          ],
          explanation: null,
          dependencies: [],
          freshness: "current",
        });
      }
    }

    run.sources = sources.map((source) => ({ ...source }));
    run.status = "observing";
    trace(
      "tool.result:" + selected.name,
      `${selected.name} returned ${outcome.status}: ${outcome.summary.slice(0, 280)}`,
      outcome.requests,
    );
    persist();

    if (outcome.status === "blocked" || outcome.status === "error") {
      run.warnings.push(`${selected.name}: ${outcome.summary.slice(0, 220)}`);
    }

    run.status = "reasoning";
  }

  const run = task.agentRun!;
  run.status = "verifying";
  run.acceptance = verifyAgentOutcome(task, input.goal, modelFinished);

  // A previously saved document can satisfy deliverable checks, but must not
  // disguise a later provider failure as a finished agent run.
  if (decisionFailed) {
    run.acceptance.checks.push({
      requirement: "Agent decision completed without provider failure",
      status: "blocked",
      artifactIds: [],
      evidenceIds: [],
    });
    run.acceptance.status = "blocked";
  }

  run.status =
    run.acceptance.status === "satisfied" ? "completed" : "partially_completed";

  if (run.requests >= maxRequests) {
    run.warnings.push("Agent reached the configured external request budget.");
  }

  if (run.status === "partially_completed") {
    run.warnings.push(
      "Agent stopped before a verified completion decision or saved deliverable.",
    );
  }

  persist();

  return {
    // A completed execution must not be reported as a failed/partial provider
    // operation. Evidence limitations remain in warning and source metadata.
    status:
      run.status === "completed"
        ? "ok"
        : sources.length || run.steps.length
          ? "partial"
          : "blocked",
    sources,
    requests: run.requests,
    ...(run.warnings.length
      ? { warning: run.warnings.join(" ").slice(0, 800) }
      : sources.length
        ? {
            warning:
              "Source leads require further verification of availability and price.",
          }
        : { warning: "No verified public source was retrieved." }),
  };
}
