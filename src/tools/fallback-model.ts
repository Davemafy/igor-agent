import { z } from "zod";
import { ModelToolProtocolError } from "./model-tool-protocol-error";
import {
  ModelOutputFormatError,
  ProviderHttpError,
} from "../core/interpretation-failure";
import type { Task } from "../core/contracts";
import type { ModelProvider } from "./interfaces";
import type { ResearchSource } from "./live-research";
import type {
  ResearchStep,
  AgentToolBrief,
  AgentToolChoice,
} from "./interfaces";

function recoverableModelError(error: unknown) {
  return (
    error instanceof ModelOutputFormatError ||
    error instanceof ModelToolProtocolError ||
    error instanceof z.ZodError ||
    error instanceof SyntaxError ||
    (error instanceof ProviderHttpError &&
      (error.status === 401 ||
        error.status === 402 ||
        (error.status === 400 &&
          (error.category === "credentials" || error.category === "billing")) ||
        error.status === 429 ||
        error.status >= 500 ||
        ([400, 422].includes(error.status) &&
          error.schemaKeywords.length > 0))) ||
    (error instanceof Error &&
      /request failed|timed out|timeout|abort/i.test(error.message))
  );
}

/** Interpretation is read-only: one configured backup may repair provider failure.
 * No cultural call, write, approval or external action is replayed here. */
export class FallbackModel implements ModelProvider {
  readonly executionMode = "tool-calling" as const;
  readonly failures: {
    provider: string;
    status: number;
    category: string | null;
  }[] = [];
  constructor(
    private primary: ModelProvider,
    private backup: ModelProvider,
  ) {}
  get calls() {
    return (this.primary.calls ?? 0) + (this.backup.calls ?? 0);
  }
  get timeoutMs() {
    return (
      (this.primary.timeoutMs ?? 5000) + (this.backup.timeoutMs ?? 5000) + 1000
    );
  }
  private usingBackup = false;
  private async readOnly<T>(
    primary: (() => Promise<T>) | undefined,
    backup: (() => Promise<T>) | undefined,
  ): Promise<T | undefined> {
    if (this.usingBackup || !primary) {
      return backup?.();
    }

    try {
      return await primary();
    } catch (error) {
      if (!recoverableModelError(error) || !backup) {
        throw error;
      }

      // A new instance belongs to one turn. Once a provider fails, keep the
      // rest of that turn on the healthy backup instead of calling it again.
      if (error instanceof ProviderHttpError) {
        this.failures.push({
          provider: error.provider,
          status: error.status,
          category: error.category,
        });
      }

      this.usingBackup = true;

      return backup();
    }
  }
  async routeConversation(text: string, context?: Task) {
    return (
      (await this.readOnly(
        this.primary.routeConversation
          ? () => this.primary.routeConversation!(text, context)
          : undefined,
        this.backup.routeConversation
          ? () => this.backup.routeConversation!(text, context)
          : undefined,
      )) ?? null
    );
  }
  async recoverConversation(text: string, context?: Task) {
    return (
      (await this.readOnly(
        this.primary.recoverConversation
          ? () => this.primary.recoverConversation!(text, context)
          : undefined,
        this.backup.recoverConversation
          ? () => this.backup.recoverConversation!(text, context)
          : undefined,
      )) ?? null
    );
  }
  async composeDraft(text: string, context: Task) {
    const draft = await this.readOnly(
      this.primary.composeDraft
        ? () => this.primary.composeDraft!(text, context)
        : undefined,
      this.backup.composeDraft
        ? () => this.backup.composeDraft!(text, context)
        : undefined,
    );

    if (!draft) {
      throw new Error("No draft provider configured.");
    }

    return draft;
  }
  async chooseResearchStep(
    question: string,
    sources: ResearchSource[],
    context: Task,
    remainingActions: number,
  ): Promise<ResearchStep> {
    const choice = await this.readOnly(
      this.primary.chooseResearchStep
        ? () =>
            this.primary.chooseResearchStep!(
              question,
              sources,
              context,
              remainingActions,
            )
        : undefined,
      this.backup.chooseResearchStep
        ? () =>
            this.backup.chooseResearchStep!(
              question,
              sources,
              context,
              remainingActions,
            )
        : undefined,
    );

    return choice ?? { action: "finish" };
  }
  async interpretAgentRequirements(goal: string, task: Task) {
    const result = await this.readOnly(
      this.primary.interpretAgentRequirements
        ? () => this.primary.interpretAgentRequirements!(goal, task)
        : undefined,
      this.backup.interpretAgentRequirements
        ? () => this.backup.interpretAgentRequirements!(goal, task)
        : undefined,
    );

    if (!result) {
      throw new Error("No acceptance interpreter configured");
    }

    return result;
  }
  async chooseAgentAction(
    goal: string,
    tools: AgentToolBrief[],
    observations: { tool: string; status: string; summary: string }[],
    context: Task,
  ): Promise<AgentToolChoice> {
    const choice = await this.readOnly(
      this.primary.chooseAgentAction
        ? () =>
            this.primary.chooseAgentAction!(goal, tools, observations, context)
        : undefined,
      this.backup.chooseAgentAction
        ? () =>
            this.backup.chooseAgentAction!(goal, tools, observations, context)
        : undefined,
    );

    if (!choice) {
      throw new Error("No model provider supports agent actions.");
    }

    return choice;
  }
  async synthesizeResearch(
    question: string,
    sources: ResearchSource[],
    context: Task,
  ) {
    const answer = await this.readOnly(
      this.primary.synthesizeResearch
        ? () => this.primary.synthesizeResearch!(question, sources, context)
        : undefined,
      this.backup.synthesizeResearch
        ? () => this.backup.synthesizeResearch!(question, sources, context)
        : undefined,
    );

    if (!answer) {
      throw new Error("No research synthesis provider configured.");
    }

    return answer;
  }
  async interpret(text: string, context?: Task) {
    return (await this.readOnly(
      () => this.primary.interpret(text, context),
      () => this.backup.interpret(text, context),
    ))!;
  }
  async recommend(task: Task, cultural: boolean) {
    const active = this.usingBackup ? this.backup : this.primary;

    return active.recommend ? active.recommend(task, cultural) : [];
  }
}
