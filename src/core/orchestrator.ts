import { focusTaskArtifact } from "./conversation-focus";
import { agentSavedDocuments } from "./agent-acceptance";
import { phaseForAction } from "./turn-lifecycle";
import { groundQuestionAnswer } from "./question-grounding";
import type { FormAnswerGrounding } from "./conversation";
import { mutateCanvas } from "./presentation";
import { ensureBoundPresentation } from "./presentation-default";
import { randomUUID } from "node:crypto";
import {
  TurnSchema,
  TaskSchema,
  type Task,
  type Event,
  type ExecutionTrace,
} from "./contracts";
import { ConflictError, type TaskStore } from "../data/store";
import { SuppliedFactsProvider } from "../tools/fixture-provider";
import type {
  CulturalProvider,
  ModelProvider,
  PracticalFactsProvider,
} from "../tools/interfaces";
import {
  runtimeCulturalProvider,
  runtimeModelProvider,
} from "../tools/runtime";
import { safeSerialize } from "../tools/qloo";
import { ExecutionBudget, withToolDeadline } from "./execution";
import {
  runtimeResearchProvider,
  researchPagePreview,
  type ResearchProvider,
  type ResearchResult,
} from "../tools/live-research";
import { invalidate } from "./revision";
import { appendReceipt } from "./receipts";
import { applyStructuredTurn } from "./apply-turn";
import { interpretMessage } from "./interpret-message";
import { compareModelRankings } from "./compare-model";
import { executeTaskPlan } from "./execute-plan";
import { turnReply } from "./turn-reply";
import { applyWorkActions } from "./connected-work";
import { recordArtifactChanges } from "./preserve-artifacts";
import { agentEmitter } from "./agent-events";
import { agentResearchLoop } from "./agent-research";
import { runUnifiedAgent } from "./unified-agent";
import { runtimePlacesProvider } from "../tools/google-maps";
import { runtimeBrowserbaseObserver } from "../tools/browserbase-observer";

export { ExecutionBudget } from "./execution";

export async function runTurn(
  store: TaskStore,
  id: string,
  owner: string,
  raw: unknown,
  send: (event: Event) => void = () => {},
  provider?: CulturalProvider,
  model?: ModelProvider,
  factsProvider: PracticalFactsProvider = new SuppliedFactsProvider(),
  researchProvider?: ResearchProvider,
  acceptedUserMessage = false,
): Promise<Task> {
  let input = TurnSchema.parse(raw);
  let formAnswer: FormAnswerGrounding | undefined;
  let task = store.load(id, owner);

  if (task.brief.version !== input.version) {
    throw new ConflictError("A newer correction is already saved.");
  }

  if (input.type === "message" && input.context) {
    focusTaskArtifact(task, input.context.artifactId);
  }

  // A form submission is one real user turn: validate, share answers with the
  // agent, and save the answer state atomically with the resulting task.
  if (input.type === "canvas" && input.mutation.operation === "answer") {
    if (!task.canvas) {
      throw new Error("No question exists for this task.");
    }

    const questionId = input.mutation.nodeId;
    const question = task.canvas.surface.nodes.find(
      (node) => node.id === questionId,
    );

    if (question?.type !== "question") {
      throw new Error("Question not found.");
    }

    task.canvas = mutateCanvas(
      task.canvas,
      input.surfaceId,
      input.mutation,
      task,
    );
    const answers = task.canvas.answers[`${input.surfaceId}:${question.id}`];
    formAnswer = groundQuestionAnswer(question, answers);
    const text = [
      question.title || question.prompt,
      ...question.fields.map(
        (field) => `${field.label}: ${answers[field.id] || "Not supplied"}`,
      ),
    ].join("\n");
    // The external answer payload has already passed its own bounded schema.
    // Keep every field when converting it to an internal message.
    input = { type: "message", text, version: input.version };
  }

  const emit = agentEmitter(structuredClone(task), send);

  if (input.type === "canvas") {
    if (!task.canvas) {
      throw new Error("No canvas exists for this task.");
    }

    task.canvas = mutateCanvas(
      task.canvas,
      input.surfaceId,
      input.mutation,
      task,
    );
    task.brief.version++;
    task.trace.push({
      id: randomUUID(),
      version: task.brief.version,
      action: "ui." + input.mutation.operation,
      outcome: "Saved a direct canvas edit to the shared task.",
      requests: 0,
      durationMs: 0,
      evidenceIds: [],
      at: new Date().toISOString(),
    });
    task.trace = task.trace.slice(-100);
    TaskSchema.parse(task);
    store.save(task, input.version, owner);
    emit({ type: "done", task: structuredClone(task) });

    return task;
  }

  const wasInterpretationError =
    task.status === "error" &&
    task.trace.at(-1)?.action === "model.interpret.error";
  model ??= runtimeModelProvider(task.mode);
  const receiptFromVersion = task.brief.version;
  const receiptTraceIds = task.trace.map((entry) => entry.id);
  const initialModelCalls = model.calls ?? 0;
  const initialCulturalCalls = provider?.calls ?? 0;

  const culturalRequestDelta = () => {
    const calls = provider?.calls;

    return calls === undefined ? undefined : calls - initialCulturalCalls;
  };

  task.modelMode = model.executionMode ?? "scripted";

  if (input.type === "baseline") {
    const version = task.brief.version;
    const comparison = await compareModelRankings(task, model, emit);
    task.brief.version++;
    appendReceipt(
      task,
      input,
      receiptFromVersion,
      ["evaluation"],
      receiptTraceIds,
      (model.calls ?? 0) - initialModelCalls,
      comparison.status,
      culturalRequestDelta(),
    );
    TaskSchema.parse(task);
    store.save(task, version, owner);
    emit({ type: "done", task });

    return task;
  }

  const budget = new ExecutionBudget();
  const at = () => new Date().toISOString();

  const trace = (
    action: string,
    outcome: string,
    requests = 0,
    evidenceIds: string[] = [],
    durationMs = 0,
  ) => {
    outcome = JSON.parse(safeSerialize(outcome)) as string;
    const row: ExecutionTrace = {
      id: randomUUID(),
      version: task.brief.version,
      action,
      outcome,
      requests,
      evidenceIds,
      durationMs,
      at: at(),
    };
    task.trace.push(row);
    const kind = action.startsWith("tool.invoke:")
      ? "tool-invocation"
      : action.startsWith("tool.result:")
        ? "tool-result"
        : action.includes("error")
          ? "action-failed"
          : "task-progress";
    emit({
      type: "action",
      message: outcome,
      phase: phaseForAction(action),
      activity: {
        eventId: row.id,
        threadId: task.id,
        taskId: task.id,
        sequence: task.trace.length,
        kind,
        actionStatus:
          kind === "tool-invocation"
            ? "executing"
            : kind === "action-failed"
              ? "failed"
              : kind === "tool-result" && outcome.includes("returned blocked")
                ? "blocked"
                : kind === "tool-result" && outcome.includes("returned error")
                  ? "failed"
                  : "completed",
        rendererType: "execution",
        evidenceIds,
      },
    });
  };

  const update =
    input.type === "message"
      ? await interpretMessage(
          task,
          input,
          model,
          budget,
          trace,
          formAnswer,
          acceptedUserMessage,
        )
      : applyStructuredTurn(task, input, {
          taskId: id,
          owner,
          readMemory: () => store.memory(owner),
        });
  task = update.task;

  if (update.researchQuery) {
    const precedingStatus = task.status;
    const precedingError = task.error;
    // Commit the user's turn before any slow external request. This is the
    // same checkpoint/optimistic-version pattern as the cultural planner:
    // a dropped stream or process restart cannot silently lose their message.
    // Another correction may advance the version while research is in flight;
    // in that case the later result MUST NOT overwrite the newer work.
    trace(
      "tool.invoke:search_web",
      "Searching public sources through Bright Data.",
    );
    const researchStageVersion = ++task.brief.version;
    task.status = "running";
    task.error = null;
    task.trace = task.trace.slice(-100);
    TaskSchema.parse(task);
    store.save(task, receiptFromVersion, owner);
    emit({ type: "state", task: structuredClone(task) });

    // Run Qloo locality/category exploration alongside web research when
    // the current conversation supplies a city. Unknown fees, opening times,
    // games and bookings remain unknown.
    if (update.practicalLocation && task.mode === "qloo-live") {
      provider ??= runtimeCulturalProvider(task.mode);
    }

    const autonomousAgent = Boolean(model.chooseAgentAction);
    const localityLookup =
      !autonomousAgent && update.practicalLocation && provider?.exploreLocality
        ? (() => {
            trace(
              "tool.invoke:qloo_locality",
              "Retrieving Qloo places matching the user-supplied locality and dining category.",
            );

            return withToolDeadline(
              provider.exploreLocality!(
                update.practicalLocation!,
                update.researchQuery!,
              ),
              15000,
            ).catch(() => null);
          })()
        : Promise.resolve(null);
    const liveResearch = researchProvider ?? runtimeResearchProvider();
    let research: ResearchResult;

    try {
      if (autonomousAgent) {
        // The same persisted task and provider contracts now feed one
        // model-directed execution loop; no fixed tool order is imposed.
        provider ??=
          task.mode === "qloo-live"
            ? runtimeCulturalProvider(task.mode)
            : undefined;
        research = await runUnifiedAgent({
          task,
          store,
          owner,
          goal: input.type === "message" ? input.text : update.researchQuery,
          model,
          research: liveResearch,
          cultural: provider,
          places: process.env.GOOGLE_MAPS_API_KEY
            ? runtimePlacesProvider()
            : undefined,
          browser: process.env.BROWSERBASE_API_KEY
            ? runtimeBrowserbaseObserver()
            : undefined,
          trace,
          send: emit,
        });
      } else {
        research = await withToolDeadline(
          liveResearch.research(update.researchQuery),
          40000,
        );
      }
    } catch (error) {
      // Optimistic write conflicts must propagate. They mean the user made a
      // newer edit, which always wins over a late agent observation.
      if (error instanceof ConflictError) {
        throw error;
      }

      research = {
        status: "error",
        sources: [],
        requests: 0,
        warning: "Live research failed before source verification.",
      };
    }

    trace(
      "tool.result:search_web",
      `Research returned ${research.status}: ${research.sources.length} sources, ${research.requests} external requests.`,
      research.requests,
    );

    // Real agentic continuation: inspect the actual web observations before
    // deciding whether a second search or a verified-source read is useful.
    // The runtime enforces exact observed source IDs and a finite tool budget.
    if (!autonomousAgent) {
      research = await agentResearchLoop(
        input.type === "message" ? input.text : update.researchQuery,
        update.researchQuery,
        research,
        liveResearch,
        model,
        task,
        trace,
      );
    }

    const locality = await localityLookup;
    const qlooPlaces = locality?.data.places ?? [];
    const qlooEvidence = locality?.data.evidence ?? [];

    if (update.practicalLocation) {
      trace(
        "tool.result:qloo_locality",
        locality
          ? `Qloo locality lookup returned ${locality.status} with ${qlooPlaces.length} place leads and ${locality.requestCount} requests.`
          : "Qloo locality exploration unavailable; public-web results remain independent.",
        locality?.requestCount ?? 0,
        locality?.evidenceIds ?? [],
      );
    }

    task.evidence.push(...qlooEvidence);
    const researchEvidenceIds = research.sources.map((source) =>
      task.agentRun
        ? `${task.id}:agent:${task.agentRun.id}:${source.id}`
        : `${task.id}:web:${receiptFromVersion + 1}:${source.id}`,
    );

    for (const [index, source] of research.sources.entries()) {
      const previewImageUrl =
        source.imageUrl ??
        researchPagePreview(source.excerpt ?? "", source.url);

      task.evidence.push({
        id: researchEvidenceIds[index],
        source: "provider-returned",
        kind: "practical",
        at: source.retrievedAt,
        reference: source.url,
        title: source.title,
        ...(previewImageUrl ? { previewImageUrl } : {}),
        entityIds: [],
        summary: `${source.title}: ${(source.excerpt ?? source.snippet).slice(0, 1100)}`,
        limitations: source.excerpt
          ? [
              "Retrieved webpage text is third-party content, not independently verified.",
            ]
          : ["Search snippet only; webpage was not opened."],
        explanation: null,
        dependencies: [],
        freshness: "current",
      });
    }

    let answer = "";

    if (research.sources.length && model.synthesizeResearch) {
      try {
        const synthesized = await withToolDeadline(
          model.synthesizeResearch(
            input.type === "message" ? input.text : update.researchQuery,
            research.sources,
            structuredClone(task),
          ),
          model.timeoutMs ?? 30000,
        );
        const ids = new Set(research.sources.map((source) => source.id));
        const used = new Set(synthesized.sourceIds);
        const inline = [...synthesized.text.matchAll(/\[(web-\d+)\]/g)].map(
          (match) => match[1],
        );

        if (
          !inline.length ||
          !used.size ||
          synthesized.sourceIds.some((sourceId) => !ids.has(sourceId)) ||
          inline.some((sourceId) => !used.has(sourceId)) ||
          synthesized.sourceIds.some(
            (sourceId) => !inline.includes(sourceId),
          ) ||
          /\bI(?:\s+have|['’]ve)?\s+(?:booked|ordered|purchased|sent|reserved)\b/i.test(
            synthesized.text,
          )
        ) {
          throw new Error("Research synthesis contains unsupported claims.");
        }

        answer = synthesized.text;
      } catch {
        // Never replace real provider observations with fabricated synthesis.
        trace(
          "model.research.error",
          "Research synthesis was unavailable; real source observations are preserved.",
        );
        research.status = "partial";
      }
    }

    const references = research.sources
      .map(
        (source) =>
          `[${source.id}] ${source.title
            .replace(/[\r\n]/g, " ")
            .replaceAll("[", "(")
            .replaceAll("]", ")")
            .slice(
              0,
              140,
            )} — ${source.url}${source.excerpt ? " (page retrieved)" : " (search snippet only)"}`,
      )
      .join("\n");

    const qlooReferences = qlooPlaces
      .map(
        (place, index) =>
          `${index + 1}. ${place.name} (Qloo locality/category result${place.address ? ` · ${place.address}` : ""})${place.website ? ` — ${place.website}` : ""}; game inventory, Saturday hours, fees and bookings unverified`,
      )
      .join("\n");
    const allEvidenceIds = [
      ...researchEvidenceIds,
      ...qlooEvidence.map((item) => item.id),
    ];
    const savedOutcome = autonomousAgent
      ? agentSavedDocuments(task)[0]
      : undefined;

    if (savedOutcome) {
      allEvidenceIds.push(
        ...savedOutcome.evidenceIds.filter(
          (id) => !allEvidenceIds.includes(id),
        ),
      );
    }

    const recoveryMessage = research.sources.length
      ? "I found useful sources, but couldn't finish the requested work. Your saved work is preserved. Ask me to continue from these findings."
      : "I couldn't finish this step. Your saved work is preserved. Ask me to retry the unfinished step.";
    const message = [
      (savedOutcome
        ? `Saved: ${savedOutcome.title}\n\n${savedOutcome.content}${task.agentRun?.status !== "completed" ? "\n\nSome requirements still need verification. Ask me to continue from this saved draft." : ""}`
        : answer) ||
        (research.sources.length
          ? "I retrieved these sources, but could not verify a complete answer. Here is the available evidence."
          : autonomousAgent
            ? recoveryMessage
            : (research.warning ??
              "Live research is unavailable; no external facts were retrieved.")),
      !autonomousAgent && research.warning && research.sources.length
        ? research.warning
        : "",
      references ? `Sources:\n${references}` : "",
      qlooReferences
        ? `Qloo place leads (geography/category matches, not personalized affinity):\n${qlooReferences}`
        : "",
      locality?.warnings.length
        ? `Qloo limitation: ${locality.warnings.join(" ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    task.messages.push({
      role: "assistant",
      kind: "conversation",
      text: message,
      evidenceIds: allEvidenceIds,
      at: at(),
    });

    if (research.sources.length || qlooPlaces.length) {
      if (!task.brief.goal && update.practicalLocation) {
        task.brief.goal = `Explore practical options in ${update.practicalLocation}`;
      }

      // Public research must deliver actual, persistent work rather than a
      // chat promise. Each run creates a traceable, editable research document,
      // with evidence IDs resolving to provider-returned source URLs.
      // We never replace previous manually edited or locked documents.
      const alreadyComposed = task.agentRun?.steps.some(
        (step) => step.tool === "document.create" && step.status === "ok",
      );

      if (!alreadyComposed) {
        const report = [
          "# Explored options",
          ...(update.practicalLocation
            ? [
                `Requested locality: ${update.practicalLocation} (user-supplied)`,
                "",
              ]
            : []),
          answer ||
            "Research returned these references. A full synthesized comparison could not be verified.",
          "",
          "## Retrieved references",
          ...research.sources.map(
            (source) =>
              `- [${source.id}] ${source.title.replace(/[\r\n]/g, " ").slice(0, 140)} — ${source.url} (${source.excerpt ? "page text opened" : "search snippet only"})`,
          ),
          "",
          ...(qlooPlaces.length
            ? [
                "",
                "## Qloo location and restaurant-category results",
                ...qlooPlaces.map(
                  (place, index) =>
                    `${index + 1}. ${place.name}${place.address ? ` — ${place.address}` : ""}${place.website ? ` — ${place.website}` : ""} (Qloo location/category lead; games and availability unverified)`,
                ),
              ]
            : []),
          "## Before you go",
          "Sources are leads, not confirmation of prices, seating, operating hours, board games or a reservation. Confirm with the venue before committing money or travel.",
          ...(research.warning
            ? ["", `Research limitation: ${research.warning}`]
            : []),
        ].join("\n");
        task.artifacts.push({
          id: `web-research-${researchStageVersion}`,
          kind: "research-report",
          title: update.practicalLocation
            ? `${update.practicalLocation} — options to check`
            : "Research-backed options",
          content: report,
          version: researchStageVersion,
          dependencies: ["evidence:research"],
          evidenceIds: allEvidenceIds,
          assumptions: [
            "Public search and Qloo category results do not verify availability, games, seating or price.",
          ],
          freshness: "current",
          edited: false,
        });
      }

      trace(
        "compose.research",
        alreadyComposed
          ? "Agent already created its editable document; no duplicate research report was generated."
          : "Saved a sourced, editable research document with open verification questions.",
        0,
        allEvidenceIds,
      );
    }

    if (research.status === "ok" && (answer || savedOutcome)) {
      // A read-only answer does not invalidate previously ready cultural work.
      // Recover an earlier interpretation error only after this turn succeeds.
      task.status =
        task.agentRun?.status === "completed" && savedOutcome
          ? "ready"
          : precedingStatus === "error" || precedingStatus === "running"
            ? "partial"
            : precedingStatus;
      task.error =
        savedOutcome || precedingStatus === "error" ? null : precedingError;
    } else {
      // Report this research failure in the reply/trace without turning a
      // previously completed cultural project into an unfinished project.
      task.status = precedingStatus === "ready" ? "ready" : "partial";
      task.error =
        precedingStatus === "ready"
          ? precedingError
          : autonomousAgent
            ? savedOutcome
              ? "This draft is saved, but some requirements remain unverified. Continue from the saved work."
              : "This step is unfinished. Your previous work is preserved; ask Igor to continue."
            : (research.warning ?? "Research was not fully verified.");
    }

    if (research.sources.length || qlooPlaces.length || savedOutcome) {
      ensureBoundPresentation(task);

      if (task.status === "draft") {
        task.status = "ready";
      }
    }

    task.brief.version++;
    task.trace = task.trace.slice(-100);
    appendReceipt(
      task,
      input,
      receiptFromVersion,
      ["evidence:research"],
      receiptTraceIds,
      (model.calls ?? 0) - initialModelCalls,
      task.status,
      culturalRequestDelta() ?? 0,
    );
    TaskSchema.parse(task);
    store.save(task, task.brief.version - 1, owner);
    emit({ type: "done", task: structuredClone(task) });

    return task;
  }

  if (update.uiOnly) {
    // A conversational view switch is already validated by mutateCanvas.
    // Commit it like a direct edit: no cultural provider, planner or unrelated
    // artifact invalidation. A later real task can use this persisted state.
    task.brief.version++;
    task.trace = task.trace.slice(-100);
    appendReceipt(
      task,
      input,
      receiptFromVersion,
      ["canvas:view"],
      receiptTraceIds,
      (model.calls ?? 0) - initialModelCalls,
      task.status,
      0,
    );
    TaskSchema.parse(task);
    store.save(task, receiptFromVersion, owner);
    emit({ type: "done", task: structuredClone(task) });

    return task;
  }

  if (update.conversationOnly) {
    ensureBoundPresentation(task);

    if (wasInterpretationError) {
      task.error = null;
      task.status = task.brief.goal ? "partial" : "draft";
    }

    task.brief.version++;
    task.trace = task.trace.slice(-100);
    appendReceipt(
      task,
      input,
      receiptFromVersion,
      [],
      receiptTraceIds,
      (model.calls ?? 0) - initialModelCalls,
      task.status,
      0,
    );
    TaskSchema.parse(task);
    store.save(task, receiptFromVersion, owner);
    emit({ type: "done", task: structuredClone(task) });

    return task;
  }

  if (update.interpretationFailed) {
    task.brief.version++;
    appendReceipt(
      task,
      input,
      receiptFromVersion,
      [],
      receiptTraceIds,
      (model.calls ?? 0) - initialModelCalls,
      task.status,
      culturalRequestDelta(),
    );
    TaskSchema.parse(task);
    store.save(task, receiptFromVersion, owner);
    emit({ type: "done", task });

    return task;
  }

  if (update.workActions && !update.workAfterDiscovery) {
    const before = structuredClone(task);

    try {
      const summary = applyWorkActions(
        task,
        update.workActions,
        input.type === "message" ? input.text : undefined,
        formAnswer,
      );
      trace(
        "planner.work",
        "Selected connected composition/revision. No cultural or external request was made.",
      );
      task.messages.push({ role: "assistant", text: summary, at: at() });
    } catch (error) {
      task = before;
      task.status = "clarification";
      const question =
        error instanceof Error
          ? error.message
          : "This work update could not be applied.";
      task.messages.push({
        role: "assistant",
        kind: "conversation",
        text: question,
        at: at(),
      });
      trace("work.rejected", question);
    }

    // Connected-work turns return early; bind their latest documents before saving.
    ensureBoundPresentation(task);
    task.brief.version++;
    task.trace = task.trace.slice(-100);
    appendReceipt(
      task,
      input,
      receiptFromVersion,
      ["work"],
      receiptTraceIds,
      (model.calls ?? 0) - initialModelCalls,
      task.status,
      0,
    );
    TaskSchema.parse(task);
    store.save(task, receiptFromVersion, owner);
    emit({ type: "done", task: structuredClone(task) });

    return task;
  }

  provider ??= runtimeCulturalProvider(task.mode);

  const { changedDependencies, artifactEdit, localChangeOnly, memoryChange } =
    update;

  if (artifactEdit) {
    changedDependencies.push(artifactEdit.artifactId);
  }

  const editedArtifactWasCurrent = artifactEdit
    ? task.artifacts.find((a) => a.id === artifactEdit.artifactId)
        ?.freshness === "current"
    : false;

  if (task.mode === "qloo-live") {
    task.evidence.forEach((evidence) => {
      if (evidence.source === "provider-returned") {
        evidence.delivery = "CACHED";
      }
    });
    [...task.catalogue, ...task.candidates].forEach((candidate) =>
      Object.values(candidate.cultural ?? {}).forEach((association) => {
        association.delivery = "CACHED";
      }),
    );
  }

  if (
    task.brief.contextAnchor &&
    changedDependencies.length &&
    changedDependencies.every(
      (dependency) =>
        dependency === "selection" || dependency.startsWith("preferences:"),
    )
  ) {
    update.needsDiscovery = false;
  }

  const oldVersion = task.brief.version;
  const stale = invalidate(task, changedDependencies);
  task.brief.version++;
  task.status = "running";
  task.error = null;

  if (artifactEdit) {
    const a = task.artifacts.find((a) => a.id === artifactEdit.artifactId);

    if (!a) {
      throw new Error("Artifact not found.");
    }

    a.freshness = "stale";
  }

  // Publish stale outputs before waiting on providers; the UI must not show them as current.
  store.save(task, oldVersion, owner);
  emit({ type: "state", task: structuredClone(task) });

  if (stale.length) {
    trace(
      "revision.invalidate",
      `Marked ${stale.length} dependent records stale.`,
    );
  }

  const stageVersion = task.brief.version;

  const previousArtifacts = structuredClone(task.artifacts);
  const previousEvidence = structuredClone(task.evidence);
  task = await executeTaskPlan(
    task,
    update,
    {
      cultural: provider,
      facts: factsProvider,
      budget,
      trace,
      now: at,
    },
    editedArtifactWasCurrent,
  );

  let connectedReply = "";

  if (update.workActions?.length && update.workAfterDiscovery) {
    const culturalStatus = task.status;
    const culturalNote = task.error ?? task.brief.unresolved.join(" ");

    try {
      connectedReply = applyWorkActions(
        task,
        update.workActions,
        input.type === "message" ? input.text : undefined,
        formAnswer,
      );
      changedDependencies.push("work");
      trace(
        "planner.work",
        "Applied connected proposals after the cultural capability. Unretrieved relationships remain proposals, not evidence.",
      );

      if (culturalStatus !== "ready") {
        task.status = "partial";
        connectedReply += `\n\nCultural step remains ${culturalStatus}: ${culturalNote || "Some cultural or practical evidence remains unresolved."}`;
      }
    } catch (error) {
      task.status = "partial";
      connectedReply =
        error instanceof Error
          ? error.message
          : "Connected proposals could not be applied.";
      trace("work.rejected", connectedReply);
    }
  }

  recordArtifactChanges(task, previousArtifacts);
  const archive = [...(task.evidenceArchive ?? [])];

  for (const old of previousEvidence) {
    const next = task.evidence.find((e) => e.id === old.id);

    if (
      (!next || next.at !== old.at || next.summary !== old.summary) &&
      !archive.some(
        (e) => e.id === old.id && e.at === old.at && e.summary === old.summary,
      )
    ) {
      archive.push(old);
    }
  }

  task.evidenceArchive = archive;

  if (task.work) {
    const affectedDecisions = task.work.decisions.filter((d) =>
      d.evidenceIds.some(
        (id) =>
          !task.evidence.some((e) => e.id === id && e.freshness === "current"),
      ),
    );

    for (const decision of affectedDecisions) {
      decision.conflict =
        "Cited evidence changed. Your decision is preserved; review its support.";
    }

    const staleIds = new Set<string>(
      task.work.documents
        .filter((d) =>
          d.evidenceIds.some(
            (id) =>
              !task.evidence.some(
                (e) => e.id === id && e.freshness === "current",
              ),
          ),
        )
        .map((d) => `document:${d.id}`),
    );
    affectedDecisions.forEach((d) => staleIds.add(`decision:${d.id}`));
    let expanded = true;

    while (expanded) {
      expanded = false;

      for (const doc of task.work.documents) {
        if (
          doc.dependencies.some((id) => staleIds.has(id)) &&
          !staleIds.has(`document:${doc.id}`)
        ) {
          staleIds.add(`document:${doc.id}`);
          expanded = true;
        }
      }
    }

    for (const doc of task.work.documents) {
      if (staleIds.has(`document:${doc.id}`)) {
        doc.freshness = "stale";
        doc.conflict =
          "Cited evidence or a dependent document changed. Review before reusing this proposal.";
      }
    }
  }

  ensureBoundPresentation(task);
  task.brief.version++;
  task.trace = task.trace.slice(-100);
  task.messages.push({
    role: "assistant",
    text: connectedReply || turnReply(task, localChangeOnly),
    at: at(),
  });
  TaskSchema.parse(task);
  appendReceipt(
    task,
    input,
    receiptFromVersion,
    changedDependencies,
    receiptTraceIds,
    (model.calls ?? 0) - initialModelCalls,
    task.status,
    culturalRequestDelta(),
  );
  TaskSchema.parse(task);
  // A newer correction can commit during a provider call. The version check rejects the late result.
  store.save(
    task,
    stageVersion,
    owner,
    task.status !== "error" ? memoryChange : undefined,
  );
  emit({ type: "done", task: structuredClone(task) });

  return task;
}
