import { normalizeAgentArguments } from "./agent-argument-normalization";
import { recordArtifactChanges } from "./preserve-artifacts";
import { preservePartialAgentWork } from "./agent-recovery-artifact";
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
import type {
  AgentToolChoice,
  ModelProvider,
  CulturalProvider,
} from "../tools/interfaces";
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
  const argumentRepairs = new Map<string, number>();
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
    // Partial cultural results are still useful evidence for an editable
    // provisional artifact. Missing seeds must remain unsatisfied at acceptance,
    // but should not prevent the user from receiving saved working output.
    const hasObservedSeed = run.culturalSeedIds?.some((seed) =>
      task.catalogue.some((candidate) =>
        Object.values(candidate.cultural ?? {}).some((signal) =>
          signal.seedIds.includes(seed),
        ),
      ),
    );
    const hasCurrentCulturalEvidence = task.evidence.some(
      (evidence) =>
        evidence.kind === "cultural" &&
        evidence.source === "provider-returned" &&
        evidence.freshness === "current",
    );
    const culturalObserved = !!hasObservedSeed && hasCurrentCulturalEvidence;
    const hasRequestedOutput =
      (run.outputArtifactIds?.length ?? 0) > 0 ||
      task.artifacts.some((artifact) =>
        artifact.id.startsWith(`agent-doc-${run.id}`),
      );
    const needsDeliverable =
      !!run.requirements?.deliverables.length ||
      !!run.requirements?.experienceDomains?.length;
    const canSave =
      culturalObserved ||
      run.sources.length > 0 ||
      !run.requirements?.culturalDecision;
    const saveBeforeLimit =
      index >= maxSteps - 2 &&
      !hasRequestedOutput &&
      needsDeliverable &&
      canSave;
    const failedComplexComposition = run.steps.some(
      (step) => step.tool === "experience.compose" && step.status === "blocked",
    );
    const canProposeExperience =
      Boolean(run.requirements?.culturalDecision) &&
      culturalReady &&
      tools.some(
        (tool) => tool.name === "experience.propose" && tool.available,
      );

    // Keep both compatible creation paths available. The model prefers
    // the compact proposal for new work; existing granular composition and
    // selective revision remain usable without changing caller contracts.
    const savePlainDocument =
      !hasRequestedOutput &&
      needsDeliverable &&
      canSave &&
      (!canProposeExperience || index === maxSteps - 1) &&
      (failedComplexComposition || (saveBeforeLimit && index === maxSteps - 1));
    const forceSaving = saveBeforeLimit || savePlainDocument;
    const savingTools = savePlainDocument
      ? ["document.create"]
      : canProposeExperience
        ? ["experience.propose", "document.create", "experience.compose"]
        : ["document.create", "experience.compose"];
    // One successful cultural seed is not evidence for the other named seeds.
    // Permit a provisional draft only when further discovery failed or the
    // bounded run must save actual observations before the step budget ends.
    const waitingForCulture =
      Boolean(run.requirements?.culturalDecision) &&
      !culturalReady &&
      !discoveryFailed &&
      !saveBeforeLimit &&
      !failedComplexComposition;
    const culturalToolsAvailable = tools.some(
      (tool) => tool.available && tool.name.startsWith("qloo."),
    );
    const mustContinue =
      index < maxSteps - 1 &&
      ((waitingForCulture && culturalToolsAvailable) ||
        (needsDeliverable && !hasRequestedOutput && canSave));
    // Explicit public research requires a genuine observation before a
    // document proposal. The model still chooses the search query; it cannot
    // treat a hypothetical memo as completed external investigation.
    const unsuccessfulSearches = run.steps.filter(
      (step) => step.tool === "web.search" && step.status !== "ok",
    ).length;
    const researchFirst =
      !run.requirements?.culturalDecision &&
      /\b(?:research|investigate|fact[ -]?check|source[ -]?backed|verify)\b/i.test(
        input.goal,
      ) &&
      input.research.available !== false &&
      !run.sources.length &&
      !run.steps.some((step) => step.tool === "web.search") &&
      index < maxSteps - 2;

    const available = tools.filter(
      (t) =>
        t.available &&
        (!readsExhausted || t.permission === "internal") &&
        (t.permission === "read" || t.permission === "internal") &&
        !(
          waitingForCulture &&
          [
            "document.create",
            "experience.compose",
            "experience.propose",
          ].includes(t.name)
        ) &&
        (!forceSaving || savingTools.includes(t.name)) &&
        !(researchFirst && t.name !== "web.search") &&
        !(t.name === "web.search" && unsuccessfulSearches >= 2) &&
        !(mustContinue && t.name === "agent.finish"),
    );
    // Enforce prerequisites from explicit, user-supplied cultural anchors.
    // The model still chooses open-ended actions, but must not skip named
    // Qloo dependencies, hallucinate a provider ID, or revise a missing doc.
    const userText = [
      input.goal,
      ...task.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
    ]
      .join(" ")
      .toLocaleLowerCase();
    const culturalPrerequisite = waitingForCulture
      ? references
          .flatMap<AgentToolChoice>((name) => {
            if (!userText.includes(name.toLocaleLowerCase())) {
              return [];
            }

            const entity = task.entities.find(
              (item) =>
                item.status === "resolved" &&
                item.name.toLocaleLowerCase() === name.toLocaleLowerCase() &&
                item.providerId,
            );

            if (!entity) {
              // Qloo's broad /search can return a film, artist and person
              // sharing a name. Pass only conservative type hints grounded in
              // the user's phrasing; Qloo still confirms the exact identity.
              const position = userText.indexOf(name.toLocaleLowerCase());
              const after = userText.slice(
                position + name.length,
                position + name.length + 24,
              );
              const before = userText.slice(
                Math.max(0, position - 24),
                position,
              );
              const personCue =
                /^\s+(?:films?|movies?)\b/i.test(after) ||
                /\bfilms?\s+(?:by|from)\s+$/i.test(before);
              const knownArtistReference = task.entities.some(
                (saved) =>
                  saved.status === "resolved" &&
                  saved.type === "artist" &&
                  references.some(
                    (reference) =>
                      reference.toLocaleLowerCase() ===
                      saved.name.toLocaleLowerCase(),
                  ),
              );
              const musicContext =
                !personCue &&
                (run.requirements?.experienceDomains?.includes("music") ||
                  knownArtistReference);
              const type = personCue
                ? "person"
                : musicContext
                  ? "artist"
                  : undefined;

              return [
                {
                  name: "qloo.resolve_entity",
                  arguments: type ? { name, type } : { name },
                },
              ];
            }

            if (observedSeeds.has(entity.providerId!)) {
              return [];
            }

            const targetType =
              entity.type === "person"
                ? "movie"
                : entity.type === "artist" ||
                    entity.type === "movie" ||
                    entity.type === "tv_show" ||
                    entity.type === "place"
                  ? entity.type
                  : null;

            return targetType
              ? [
                  {
                    name: "qloo.discover",
                    arguments: { entityId: entity.id, targetType },
                  },
                ]
              : [];
          })
          .find((choice) => {
            const fingerprint =
              choice.name + ":" + JSON.stringify(choice.arguments);

            return (
              available.some((tool) => tool.name === choice.name) &&
              !attempted.has(fingerprint)
            );
          })
      : undefined;
    let selection: Awaited<
      ReturnType<NonNullable<ModelProvider["chooseAgentAction"]>>
    >;

    if (culturalPrerequisite) {
      selection = culturalPrerequisite;
      trace(
        "agent.prerequisite",
        "Executing a validated user-supplied cultural dependency.",
      );
    } else {
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
            run.steps.map((step) => ({
              tool: step.tool,
              status: step.status,
              summary: step.summary,
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
    }

    const selected = available.find(
      (t) => t.name === selection.name && t.available,
    );

    if (!selected) {
      if (
        selection.name === "agent.finish" &&
        mustContinue &&
        finishRepairs++ < 2
      ) {
        const missing =
          run.requirements?.deliverables.join(", ") || "required work";
        run.steps.push({
          id: randomUUID(),
          tool: "agent.finish",
          status: "blocked",
          requests: 0,
          summary: `Completion is not verified: save ${missing} first.`,
          at: now(),
          durationMs: 0,
        });
        trace("agent.finish.blocked", "Required work is still incomplete.");
        persist();
        continue;
      }

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
      args = selected.schema.parse(
        normalizeAgentArguments(selected.name, selection.arguments),
      );
    } catch (error) {
      // Report only declared schema field names and issue codes, never
      // untrusted model values or arbitrary object keys.
      const safeFields = new Set([
        "title",
        "content",
        "sourceIds",
        "evidenceIds",
        "candidateIds",
        "fulfills",
        "actions",
        "artifactId",
        "kind",
        "id",
        "dependencies",
        "domain",
        "rationale",
        "estimatedCost",
      ]);
      const schemaIssues =
        error instanceof z.ZodError
          ? error.issues
              .slice(0, 6)
              .map((issue) => {
                const fields = issue.path.filter(
                  (part) => typeof part === "string" && safeFields.has(part),
                );
                const path = fields.join(".");

                return `${path || "arguments"}:${issue.code}`;
              })
              .join(", ")
          : "unclassified";

      run.warnings.push(`Invalid arguments for ${selected.name}`);
      trace(
        "agent.action.blocked",
        "Tool argument schema rejected the proposal; no tool executed.",
      );

      const repaired = argumentRepairs.get(selected.name) ?? 0;
      argumentRepairs.set(selected.name, repaired + 1);

      if (repaired === 0) {
        run.steps.push({
          id: randomUUID(),
          tool: selected.name,
          status: "blocked",
          requests: 0,
          summary: `Arguments rejected (${schemaIssues}). Correct this tool's inputSchema fields. No tool executed.`,
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
  // A failed model must not discard real observations. Save an explicitly
  // incomplete, source-linked workpad; never mark requested deliverables done.
  const recovered = preservePartialAgentWork(task, sources);

  if (recovered) {
    run.outputArtifactIds = [
      ...new Set([...(run.outputArtifactIds ?? []), recovered]),
    ].slice(-12);
    trace(
      "agent.recovery.saved",
      "Preserved verified observations in an incomplete editable workpad.",
    );
  }

  run.status = "verifying";
  run.acceptance = verifyAgentOutcome(task, input.goal, modelFinished);

  if (recovered) {
    run.acceptance.checks.push({
      requirement: "Recovery workpad is not a completed requested deliverable",
      status: "blocked",
      artifactIds: [recovered],
      evidenceIds: [],
    });
    run.acceptance.status = "blocked";
  }

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
