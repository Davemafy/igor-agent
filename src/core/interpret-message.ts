import { installPresentation, validatePresentation } from "./presentation";
import { resolveOrdinalFocus } from "./conversation-focus";
import { sourceLinkedDocumentMedia } from "./document-media";
import { practicalDiscoveryOpportunity } from "./action-readiness";
import {
  interpretationFailure,
  ProviderHttpError,
} from "./interpretation-failure";
import { assertGroundedOutcome, OutcomeGroundingError } from "./outcome-spec";
import { ModelToolProtocolError } from "../tools/model-tool-protocol-error";
import {
  TurnSchema,
  InterpretationSchema,
  type Task,
  type Turn,
} from "./contracts";
import { z } from "zod";
import type { ModelProvider } from "../tools/interfaces";
import type { Trace } from "../capabilities/contract";
import { ExecutionBudget, withToolDeadline } from "./execution";
import {
  applyConversationActions,
  type FormAnswerGrounding,
} from "./conversation";
import {
  unchangedTurn,
  type ArtifactEdit,
  type TurnUpdate,
} from "./apply-turn";

export async function interpretMessage(
  task: Task,
  input: Extract<Turn, { type: "message" }>,
  model: ModelProvider,
  budget: ExecutionBudget,
  trace: Trace,
  formAnswer?: FormAnswerGrounding,
  messageAccepted = false,
): Promise<TurnUpdate> {
  // Never reinterpret arbitrary short messages as a taste-profile form answer.
  // "Go", a correction or a topic switch still belongs to the full conversation
  // interpreter. Actual question-form submissions arrive with explicit
  // formAnswer grounding from the validated canvas-answer handler.

  const update = unchangedTurn(task);
  const changedDependencies: string[] = [];
  let needsDiscovery = false;
  let localChangeOnly = false;
  let artifactEdit: ArtifactEdit | undefined;
  let clarification: string | null = null;
  const at = () => new Date().toISOString();

  budget.take("interpret");
  const interpretationStarted = Date.now();
  const callsBefore = model.calls ?? 0;
  let parsed: z.infer<typeof InterpretationSchema>;
  // The failed turn was already saved in SQLite before the user clicked
  // Try again. Reinterpret it without copying the same user message twice.
  // Only a matching *last* failed interpretation is eligible; a new message
  // or a different failure type must always create a fresh turn.
  const replayingFailedTurn =
    !messageAccepted &&
    task.status === "error" &&
    task.trace.at(-1)?.action === "model.interpret.error" &&
    task.messages.at(-1)?.role === "user" &&
    task.messages.at(-1)?.text === input.text;
  const context = structuredClone(task);

  if (messageAccepted) {
    // The API committed this user's message before the model call.
    // Exclude only that latest current-turn message from prior context.
    if (
      task.messages.at(-1)?.role !== "user" ||
      task.messages.at(-1)?.text !== input.text
    ) {
      throw new Error("Accepted turn does not match the saved user message.");
    }

    context.messages.pop();
  } else if (replayingFailedTurn) {
    context.messages.pop();
  }

  const initialRequestText = [
    input.text,
    ...context.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text)
      .reverse(),
  ].join("\n");

  if (!messageAccepted && !replayingFailedTurn) {
    task.messages.push({ role: "user", text: input.text, at: at() });
  }

  const referenced = resolveOrdinalFocus(task, input.text);

  if (referenced.kind === "ambiguous") {
    task.messages.push({
      role: "assistant",
      kind: "conversation",
      text: "Which set of options do you mean? Open the current choices or name the one you want.",
      at: at(),
    });
    trace(
      "conversation.reference.ambiguous",
      "Ordinal has no current saved option.",
    );

    return { ...update, task, conversationOnly: true };
  }

  try {
    // Every natural message gets a small, read-only route before the expensive
    // cultural/work decision protocol. The route can never commit an edit or
    // claim an external action. Actionable requests delegate to the full path.
    // Submitted canvas answers are a continuation of executable work, not
    // an independent conversational request. Keep them on the full interpreter.
    let routed: Awaited<
      ReturnType<NonNullable<ModelProvider["routeConversation"]>>
    > = null;

    if (!formAnswer && model.routeConversation) {
      try {
        routed = await withToolDeadline(
          model.routeConversation(input.text, context),
          model.timeoutMs ?? 5000,
        );
      } catch (error) {
        // A malformed read-only route must not poison the whole conversation.
        // A different, existing interpreter schema can recover it once.
        // Do not replay auth, rate-limit, network or provider outage failures:
        // another request to the same backend would waste time and credits.
        const malformed =
          error instanceof z.ZodError ||
          error instanceof SyntaxError ||
          (error instanceof ProviderHttpError &&
            [400, 422].includes(error.status) &&
            error.schemaKeywords.length > 0) ||
          (error instanceof Error &&
            /Unauthorized model tool|Exactly one allowed tool|Model decision could not be validated/.test(
              error.message,
            ));

        if (!malformed) {
          throw error;
        }

        trace(
          "model.route.recovered",
          `Read-only routing rejected (${interpretationFailure(error)}); trying the independent interpreter once.`,
          (model.calls ?? 0) - callsBefore,
        );
      }
    }

    const opportunity = !formAnswer
      ? practicalDiscoveryOpportunity(task, input.text)
      : null;
    const researchQuery =
      opportunity?.query ??
      (routed?.intent === "research" ? routed.query : undefined);

    if (
      researchQuery &&
      (routed?.intent === "research" ||
        (opportunity &&
          (!routed ||
            routed.intent === "conversation" ||
            routed.intent === "clarification")))
    ) {
      trace(
        "research.route",
        opportunity
          ? "Planning context is actionable; execute bounded real-world source research rather than asking another question or promising a plan."
          : "Selected a bounded read-only public-web research task.",
        (model.calls ?? 0) - callsBefore,
      );

      return {
        ...update,
        task,
        researchQuery,
        ...(opportunity ? { practicalLocation: opportunity.city } : {}),
      };
    }

    if (routed?.intent === "draft") {
      if (!model.composeDraft) {
        throw new Error("Draft model is not configured.");
      }

      const draft = await withToolDeadline(
        model.composeDraft(input.text, context),
        model.timeoutMs ?? 30000,
      );
      // A small authoring schema produces real persistent work without the
      // heavyweight planning protocol. Existing artifacts/approvals are untouched.
      parsed = InterpretationSchema.parse({
        intent: "conversation",
        reply: `Here is a first draft of ${draft.title}. You can edit it below.`,
        presentation: {
          id: `draft-${task.brief.version + 1}`,
          title: draft.title,
          basis: "draft",
          root: "document",
          nodes: [
            {
              id: "document",
              type: "document",
              title: draft.title,
              content: draft.content,
              media: sourceLinkedDocumentMedia(task, draft.content),
            },
          ],
        },
      });
    } else {
      parsed = InterpretationSchema.parse(
        routed ??
          (await withToolDeadline(
            model.interpret(input.text, context),
            model.timeoutMs ?? 5000,
          )),
      );
    }

    // An actual answer to Igor's outstanding taste question may be a short
    // artist or film name. Do not misinterpret continuation commands or
    // unrelated replies as an implicit preference.
    if (
      !formAnswer &&
      task.brief.unresolved.includes(
        "What is one artist, film, book or place you enjoy that could guide this?",
      ) &&
      input.text.trim().length <= 100 &&
      !/^(?:go|go ahead|continue|next|yes|yep|yeah|okay|ok|no|nah|huh|wait|stop|proceed|do it|the first|the second|the third|that one)$/i.test(
        input.text.trim(),
      ) &&
      parsed.intent === "revision" &&
      parsed.actions?.some(
        (action) =>
          (action.kind === "preference" &&
            action.participant === "you" &&
            action.polarity === "like" &&
            !!action.entityType &&
            action.value.toLocaleLowerCase() ===
              input.text.trim().toLocaleLowerCase()) ||
          (action.kind === "profile" &&
            action.participant === "you" &&
            action.preferences.some(
              (preference) =>
                preference.polarity === "like" &&
                !!preference.entityType &&
                preference.value.toLocaleLowerCase() ===
                  input.text.trim().toLocaleLowerCase(),
            )),
      )
    ) {
      formAnswer = { subject: "you", values: [input.text.trim()] };
    }

    if (parsed.intent === "conversation" || parsed.intent === "clarification") {
      for (const id of parsed.replyEvidenceIds) {
        if (
          !task.evidence.some(
            (evidence) =>
              evidence.id === id && evidence.freshness === "current",
          )
        ) {
          throw new Error("Conversation cited unavailable evidence.");
        }
      }
    }

    if (parsed.presentation) {
      try {
        parsed.presentation = validatePresentation(parsed.presentation, task);
      } catch {
        parsed.presentation = undefined;
      }
    }

    if (parsed.outcome) {
      const explicitRevision =
        parsed.intent === "revision" &&
        task.brief.outcome?.kind === parsed.outcome.kind;
      assertGroundedOutcome(
        parsed.outcome,
        parsed.intent === "goal" && !context.brief.goal
          ? initialRequestText
          : input.text,
        explicitRevision ? task.brief.outcome : undefined,
      );
      const expectedTarget =
        parsed.outcome.kind === "itinerary"
          ? "place"
          : parsed.outcome.kind === "research"
            ? parsed.targetType
            : "artist";

      if (parsed.targetType === undefined) {
        parsed.targetType = expectedTarget;
      } else if (parsed.targetType !== expectedTarget) {
        throw new OutcomeGroundingError(
          "Should I put together a place-based itinerary or a cultural shortlist first?",
        );
      }
    }
  } catch (error) {
    if (error instanceof OutcomeGroundingError) {
      trace(
        "proposal.clarify",
        error.message,
        (model.calls ?? 0) - callsBefore,
      );
      task.messages.push({
        role: "assistant",
        kind: "conversation",
        text: error.question,
        at: at(),
      });

      return { ...update, task, conversationOnly: true };
    }

    // The large update_brief schema can fail independently of a healthy
    // conversational model. Rescue once through a separate READ-ONLY route:
    // no Qloo, external calls, state edits or invented execution receipts.
    // This is not a retry of the rejected planning action.
    const recoverableDecision =
      error instanceof ModelToolProtocolError ||
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      (error instanceof ProviderHttpError &&
        [400, 422].includes(error.status) &&
        error.schemaKeywords.length > 0) ||
      (error instanceof Error &&
        /Unauthorized model tool|Exactly one allowed tool|Model decision could not be validated|Invalid interpreted patch/.test(
          error.message,
        ));

    if (!formAnswer && recoverableDecision && model.recoverConversation) {
      try {
        const rescue = await withToolDeadline(
          model.recoverConversation(input.text, context),
          model.timeoutMs ?? 5000,
        );

        if (
          rescue &&
          (rescue.intent === "conversation" ||
            rescue.intent === "clarification") &&
          (rescue.replyEvidenceIds ?? []).every((id) =>
            task.evidence.some(
              (item) => item.id === id && item.freshness === "current",
            ),
          )
        ) {
          task.messages.push({
            role: "assistant",
            kind: "conversation",
            text: rescue.reply,
            evidenceIds: rescue.replyEvidenceIds ?? [],
            at: at(),
          });
          trace(
            "model.interpret.recovered",
            `Complex interpretation failed (${interpretationFailure(error)}). Provided a read-only conversational answer; no planning action executed.`,
            (model.calls ?? 0) - callsBefore,
          );

          return { ...update, task, conversationOnly: true };
        }
      } catch (recoveryError) {
        trace(
          "model.recovery.unavailable",
          `Read-only recovery was also unavailable (${interpretationFailure(recoveryError)}).`,
          (model.calls ?? 0) - callsBefore,
        );
      }
    }

    task.status = "error";
    const diagnostic = interpretationFailure(error);
    const reason =
      diagnostic === "provider timeout"
        ? "The model timed out"
        : /^provider HTTP 429/.test(diagnostic)
          ? "The model provider is temporarily rate-limited"
          : /^provider HTTP 5\d\d/.test(diagnostic)
            ? "The model provider is temporarily unavailable"
            : /^provider HTTP 4\d\d/.test(diagnostic)
              ? "The model provider rejected the request"
              : diagnostic.startsWith("invalid schema") ||
                  diagnostic === "invalid JSON" ||
                  diagnostic === "invalid tool call"
                ? "The model returned an invalid decision"
                : diagnostic === "model not configured"
                  ? "No model provider is configured"
                  : "The model could not finish this response";
    task.error = `${reason}. Your message and previous work are saved. No new external action was completed. You can retry this turn.`;
    trace(
      "model.interpret.error",
      `${task.error} Diagnostic: ${diagnostic}.`,
      (model.calls ?? 0) - callsBefore,
      [],
      Date.now() - interpretationStarted,
    );

    return { ...update, task, interpretationFailed: true };
  }

  for (const failure of model.failures ?? []) {
    trace(
      "model.fallback",
      `${failure.provider} returned HTTP ${failure.status}${failure.category ? ` (${failure.category})` : ""}; continued with the separately configured backup provider.`,
    );
  }

  trace(
    "model.interpret",
    parsed.intent === "conversation" || parsed.intent === "clarification"
      ? "Validated a conversational reply without planning edits."
      : "Validated supported goal or correction against the brief contract.",
    (model.calls ?? 0) - callsBefore,
    [],
    Date.now() - interpretationStarted,
  );

  if (parsed.presentation) {
    if (!task.brief.goal) {
      task.brief.goal = input.text;
    }

    task.error = null;
    task.status = parsed.intent === "clarification" ? "clarification" : "ready";
    task.canvas = installPresentation(
      task.canvas,
      validatePresentation(parsed.presentation, task),
    );
    trace(
      "ui.present",
      `Prepared ${parsed.presentation.title} with ${parsed.presentation.nodes.length} validated components.`,
    );
  }

  if (parsed.intent === "conversation" || parsed.intent === "clarification") {
    task.messages.push({
      role: "assistant",
      kind: "conversation",
      text: parsed.reply,
      evidenceIds: parsed.replyEvidenceIds,
      at: at(),
    });

    return { ...update, task, conversationOnly: true };
  }

  if (
    parsed.workActions?.length &&
    !parsed.outcome &&
    (!parsed.actions?.length ||
      (parsed.kind === "creative" &&
        parsed.actions.every((action) => action.kind === "constraints")))
  ) {
    // Logistics accompanying a document are not a request for taste discovery.
    const logistics = [...(parsed.actions ?? [])];

    if (parsed.budget !== undefined || parsed.duration !== undefined) {
      logistics.push({
        kind: "constraints",
        budget: parsed.budget,
        duration: parsed.duration,
      });
    }

    if (logistics.length) {
      const applied = applyConversationActions(
        task,
        logistics,
        input.text,
        formAnswer,
      );

      if (!applied.ok) {
        return { ...update, task, clarification: applied.question };
      }

      task = applied.task;
    }

    if (parsed.intent === "goal") {
      applyInterpretedGoal(task, parsed);
    }

    return { ...update, task, workActions: parsed.workActions };
  }

  // Validate extraction again; a future model cannot bypass the input contract.
  const patch = TurnSchema.parse({
    type: "constraints",
    budget: parsed.budget,
    duration: parsed.duration,
    version: input.version,
  });

  if (patch.type !== "constraints") {
    throw new Error("Invalid interpreted patch");
  }

  // All model-supplied numeric and wording patches use the same grounding rules,
  // including legacy top-level fields. Avoid duplicating equivalent artifact edits.
  const proposals = [...(parsed.actions ?? [])];
  const explicitDocumentEdit =
    /^edit\s+(?:main|invitation)\s*:\s*\S/i.test(input.text.trim()) ||
    // An explicitly addressed document with verbatim supplied replacement
    // wording is a direct edit, even without the redundant verb "edit".
    /^(?:edit\s+)?(?:invitation|invite|wording)\s*:\s*\S/i.test(
      input.text.trim(),
    ) ||
    /\b(?:edit|rewrite|replace|update|change|revise|set)\b[\s\S]{0,160}\b(?:document|invitation|invite|wording|copy|draft|text)\b/i.test(
      input.text,
    ) ||
    /\b(?:document|invitation|invite|wording|copy|draft)\b[\s\S]{0,100}\b(?:edit|rewrite|replace|update|change|revise|say|read)\b/i.test(
      input.text,
    );

  // A grounded intake answer is not permission to rewrite an invitation.
  // Keep supported taste extraction without letting an invented document edit
  // reject the entire answer or modify existing wording.
  // A generated document rewrite is never a user-authored replacement.
  // Drop it before the batch guard, without changing the original document.
  for (let index = proposals.length - 1; index >= 0; index--) {
    const action = proposals[index];

    if (
      action.kind === "artifact" &&
      (!explicitDocumentEdit || !input.text.includes(action.content))
    ) {
      proposals.splice(index, 1);
      trace(
        "proposal.ignored",
        "Ignored document wording that was not supplied by the user.",
      );
    }
  }

  if (parsed.budget !== undefined || parsed.duration !== undefined) {
    proposals.push({
      kind: "constraints",
      budget: parsed.budget,
      duration: parsed.duration,
    });
  }

  if (
    parsed.wording &&
    explicitDocumentEdit &&
    input.text.includes(parsed.wording) &&
    !proposals.some(
      (action) =>
        action.kind === "artifact" &&
        action.artifactId === "invitation" &&
        action.content === parsed.wording,
    )
  ) {
    proposals.push({
      kind: "artifact",
      artifactId: "invitation",
      content: parsed.wording,
    });
  }

  if (!parsed.supported) {
    clarification =
      "Choose a gathering, cultural discovery, a supplied-facts itinerary, an artist listening programme, music direction, cultural evidence report or reference-based creative brief. Other goals are not implemented.";
  } else if (
    parsed.outcome?.kind === "music-direction" &&
    /restaurant|dining/i.test(input.text) &&
    task.brief.contextAnchor?.type !== "place"
  ) {
    clarification =
      "Which resolved place should anchor the music direction? Discover places and choose a returned identity first. Igor will not invent dining-to-music evidence from an atmosphere description.";
  } else if (parsed.intent === "goal" && !parsed.goal.trim()) {
    clarification =
      "State the new goal, or describe this as a correction to the current task.";
  } else if (
    parsed.intent === "revision" &&
    parsed.outcome &&
    !proposals.length
  ) {
    task.brief.outcome = parsed.outcome;
    changedDependencies.push("outcome");
  } else if (proposals.length) {
    const applied = applyConversationActions(
      task,
      proposals,
      parsed.intent === "goal" && !context.brief.goal
        ? initialRequestText
        : input.text,
      formAnswer,
    );

    if (!applied.ok) {
      clarification = applied.question;
    } else {
      task = applied.task;
      changedDependencies.push(...applied.changed);
      needsDiscovery ||= applied.discover;

      if (parsed.intent === "goal") {
        const goalChanges = applyInterpretedGoal(task, parsed);
        changedDependencies.push(...goalChanges);
        needsDiscovery ||= goalChanges.includes("catalogue");
      }

      if (applied.artifact) {
        artifactEdit = {
          type: "artifact",
          ...applied.artifact,
          version: input.version,
        };
        localChangeOnly = true;
      }

      if (!task.candidates.length) {
        needsDiscovery = true;
      }
    }
  } else {
    if (
      parsed.intent === "goal" ||
      (parsed.intent === undefined &&
        (!task.brief.goal || !changedDependencies.length))
    ) {
      const goalChanges = applyInterpretedGoal(task, parsed);
      changedDependencies.push(...goalChanges);
      needsDiscovery ||= goalChanges.includes("catalogue");
    }

    if (task.candidates.length === 0) {
      needsDiscovery = true;
    }
  }

  // Keep explicitly supplied taste while asking for the locality needed to retrieve places.
  if (
    !clarification &&
    task.brief.targetType === "place" &&
    /^(?:at home|home screening room)$/i.test(task.brief.constraints.location)
  ) {
    clarification = "Which city or locality should Igor explore?";
  }

  const uiOnly =
    !clarification &&
    !!parsed.actions?.length &&
    parsed.actions.every((action) => action.kind === "canvas-view") &&
    !parsed.outcome &&
    !parsed.workActions?.length &&
    parsed.intent === "revision";

  if (uiOnly) {
    // The model chose a legal schema action; the actual surface mutation is
    // already validated against the saved candidate pool.
    task.messages.push({
      role: "assistant",
      kind: "conversation",
      text: "The workspace view is updated. Your options and previous decisions are preserved.",
      at: at(),
    });
  }

  return {
    ...update,
    task,
    uiOnly,
    workActions: parsed.workActions,
    workAfterDiscovery: !!parsed.workActions?.length,
    changedDependencies,
    needsDiscovery,
    localChangeOnly,
    artifactEdit,
    clarification,
  };
}

function applyInterpretedGoal(
  task: Task,
  interpretation: z.infer<typeof InterpretationSchema>,
): string[] {
  const changedDependencies = ["outcome", "goal"];

  if (task.brief.targetType !== interpretation.targetType) {
    changedDependencies.unshift("catalogue");
  }

  task.brief.outcome = interpretation.outcome;
  task.brief.goal = interpretation.goal;
  task.brief.kind = interpretation.kind;
  task.brief.targetType = interpretation.targetType;
  const keepsAnchor =
    interpretation.outcome &&
    ["music-direction", "research"].includes(interpretation.outcome.kind);

  if (!keepsAnchor) {
    task.brief.contextAnchor = undefined;
  }

  return changedDependencies;
}
