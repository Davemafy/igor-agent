import { ModelRequestBudgetError } from "../tools/model-budget";
import { ModelToolProtocolError } from "../tools/model-tool-protocol-error";
import { z } from "zod";

/** Stable error categories for model-generated tool protocol, no raw provider body. */
export class ModelOutputFormatError extends Error {
  constructor(
    readonly stage: "agent.decision" | "research.synthesis",
    readonly reason: "invalid JSON" | "invalid schema",
  ) {
    super(`${stage}: ${reason}`);
  }
}

/** Report only known categories and schema paths, never raw provider content or credentials. */
export function interpretationFailure(error: unknown): string {
  if (error instanceof ModelToolProtocolError) {
    return "invalid tool call";
  }

  if (error instanceof ModelOutputFormatError) {
    return error.message;
  }

  if (error instanceof ModelRequestBudgetError) {
    return "model request_budget exhausted";
  }

  if (error instanceof ProviderHttpError) {
    return `provider HTTP ${error.status} (${error.provider})${error.category ? `; category: ${error.category}` : ""}${error.schemaKeywords.length ? `; schema keywords: ${error.schemaKeywords.join(", ")}` : ""}`;
  }

  if (error instanceof z.ZodError) {
    const fields = new Set([
      "decision",
      "argumentsJson",
      "name",
      "domain",
      "fulfills",
      "workActions",
      "presentation",
      "id",
      "title",
      "dependencies",
      "evidenceIds",
      "amount",
      "estimatedCost",
      "rationale",
      "basis",
      "root",
      "nodes",
      "type",
      "children",
      "fields",
      "label",
      "subject",
      "binding",
      "required",
      "prompt",
      "candidateIds",
      "columns",
      "rows",
      "cells",
      "reply",
      "replyEvidenceIds",
      "candidates",
      "finishReason",
      "content",
      "parts",
      "functionCall",
      "actions",
      "kind",
      "participant",
      "preferences",
      "value",
      "polarity",
      "entityType",
      "targetType",
      "outcome",
      "intent",
      "goal",
      "supported",
      "budget",
      "duration",
      "wording",
      "days",
      "transferMinutes",
      "transitionMinutes",
    ]);
    const issues = flattenIssues(error.issues)
      .slice(0, 6)
      .map((issue) => {
        const path = issue.path
          .filter(
            (part) => typeof part === "number" || fields.has(String(part)),
          )
          .join(".");

        return `${issue.code}${path ? ` at ${path}` : ""}`;
      });

    return `invalid schema: ${issues.join(", ")}`;
  }

  if (error instanceof SyntaxError) {
    return "invalid JSON";
  }

  if (error instanceof Error) {
    if (error.message === "Model input size budget reached.") {
      return "model input_size budget exceeded before provider request";
    }

    if (
      /Unauthorized general-agent decision|Model selected a tool that was not offered/.test(
        error.message,
      )
    ) {
      return "invalid agent tool selection";
    }

    const status = /(?:Gemini|OpenAI) returned HTTP (\d{3})/.exec(
      error.message,
    );

    if (status) {
      return `provider HTTP ${status[1]}`;
    }

    if (/timed out|timeout/i.test(error.message)) {
      return "provider timeout";
    }

    if (
      /Unauthorized model tool|Exactly one allowed tool/.test(error.message)
    ) {
      return "invalid tool call";
    }

    if (error.message === "Outcome and discovery domain disagree.") {
      return "outcome domain mismatch";
    }

    if (/State the|must be explicitly supplied/.test(error.message)) {
      return "ungrounded outcome allowance";
    }
  }

  return "unclassified provider response";
}

function flattenIssues(
  issues: z.ZodError["issues"],
  depth = 0,
): z.ZodError["issues"] {
  return issues.flatMap((issue) =>
    issue.code === "invalid_union" && depth < 3
      ? issue.errors.flatMap((branch) => flattenIssues(branch, depth + 1))
      : [issue],
  );
}

/** Preserve only fixed diagnostic keywords; never retain the upstream body. */
export class ProviderHttpError extends Error {
  readonly schemaKeywords: string[];
  readonly category:
    "credentials" | "billing" | "model" | "request-schema" | null;
  constructor(
    readonly provider: "OpenAI" | "Gemini" | "Grok" | "Claude",
    readonly status: number,
    body: string,
  ) {
    super(`${provider} returned HTTP ${status}; no retry.`);
    const normalized = body.toLowerCase();
    this.category =
      /igor_error:credentials|api[ _-]?key|authentication|authorization|credential/.test(
        normalized,
      )
        ? "credentials"
        : /igor_error:billing|credit|billing|payment|balance|funds/.test(
              normalized,
            )
          ? "billing"
          : /igor_error:model|model.*(?:not exist|not found|access|unsupported)|unknown model/.test(
                normalized,
              )
            ? "model"
            : /igor_error:request-schema|schema|tool|function|parameter|argument/.test(
                  normalized,
                )
              ? "request-schema"
              : null;
    this.schemaKeywords = [
      "schema",
      "anyOf",
      "oneOf",
      "const",
      "pattern",
      "additionalProperties",
      "required",
      "properties",
      "items",
      "parameters",
      "depth",
      "complex",
      "unsupported",
      "strict",
      "enum",
      "format",
      "type",
    ].filter((keyword) => normalized.includes(keyword.toLowerCase()));
  }
}
