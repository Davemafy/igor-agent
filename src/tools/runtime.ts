import { unavailableCulturalProvider } from "./unavailable-cultural";
import { LiveQlooProvider, SqliteResponseCache } from "./qloo-live";
import { GrokModel } from "./grok-model";
import { AnthropicModel } from "./anthropic-model";
import type { ModelProvider } from "./interfaces";
import { FallbackModel } from "./fallback-model";
import { ToolCallingModel } from "./tool-model";
import { ResponsiveGeminiModel } from "./responsive-gemini";
import { RecordedQlooProvider } from "./recorded-qloo";
import { readRecordingText } from "./recording-file";
import { DevelopmentModel } from "./development-model";
import { FixtureCulturalProvider } from "./fixture-provider";
import type { Task } from "../core/contracts";

let cache: SqliteResponseCache | undefined;

/** Open the cultural cache only when this execution actually needs a live provider. */
export function runtimeCulturalProvider(mode: Task["mode"]) {
  if (mode === "illustrative-fixtures") {
    return new FixtureCulturalProvider();
  }

  if (process.env.IGOR_QLOO_RECORDING) {
    try {
      return new RecordedQlooProvider(
        JSON.parse(readRecordingText(process.env.IGOR_QLOO_RECORDING)),
      );
    } catch {
      return unavailableCulturalProvider(
        "The configured Qloo recording is missing or invalid. Cultural discovery is blocked; no live or synthetic fallback was used.",
      );
    }
  }

  cache ??= new SqliteResponseCache(
    process.env.IGOR_CACHE_PATH ?? `${process.cwd()}/.igor/qloo-cache.sqlite`,
    Math.max(1, Math.min(30, Number(process.env.QLOO_CACHE_DAYS) || 1)) *
      86400000,
  );
  const configured = Number(process.env.QLOO_MAX_CALLS ?? "30");
  const max =
    Number.isInteger(configured) && configured >= 0
      ? Math.min(30, configured)
      : 0;

  return new LiveQlooProvider(
    process.env.QLOO_API_KEY ?? "",
    cache,
    fetch,
    max,
    process.env.QLOO_CACHE_ONLY === "1",
  );
}

export function runtimeModelProvider(mode: Task["mode"]) {
  if (mode === "illustrative-fixtures") {
    return new DevelopmentModel();
  }

  const configured: { id: string; model: ModelProvider }[] = [];
  const grokKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;

  if (grokKey) {
    configured.push({
      id: "grok",
      model: new GrokModel(
        grokKey,
        process.env.XAI_MODEL || process.env.GROK_MODEL || "grok-4.3",
      ),
    });
  }

  if (process.env.ANTHROPIC_API_KEY) {
    configured.push({
      id: "claude",
      model: new AnthropicModel(
        process.env.ANTHROPIC_API_KEY,
        process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      ),
    });
  }

  if (process.env.GEMINI_API_KEY) {
    configured.push({
      id: "gemini",
      model: new ResponsiveGeminiModel(
        process.env.GEMINI_API_KEY,
        process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
      ),
    });
  }

  if (process.env.LLM_API_KEY && process.env.LLM_MODEL) {
    configured.push({
      id: "openai",
      model: new ToolCallingModel(
        process.env.LLM_API_KEY,
        process.env.LLM_MODEL,
      ),
    });
  }

  const preference = process.env.IGOR_MODEL_PROVIDER?.toLowerCase()
    .replace("anthropic", "claude")
    .replace("xai", "grok");

  if (preference) {
    const index = configured.findIndex((item) => item.id === preference);

    if (index < 0) {
      throw new Error("The preferred model provider is not configured.");
    }

    configured.unshift(...configured.splice(index, 1));
  }

  if (configured.length >= 2) {
    // Use up to three explicitly configured providers, never a fixture.
    // Nested FallbackModel instances retain their healthy selection for
    // the remainder of the turn without replaying external tool actions.
    const choices = configured.slice(0, 3).map((item) => item.model);
    let fallback = choices[choices.length - 1];

    for (let i = choices.length - 2; i >= 0; i--) {
      fallback = new FallbackModel(choices[i], fallback);
    }

    return fallback;
  }

  if (configured.length === 1) {
    return configured[0].model;
  }

  return process.env.IGOR_TEST_FIXTURES === "1" ||
    process.env.IGOR_QLOO_RECORDING ||
    process.env.NODE_ENV === "test"
    ? new DevelopmentModel()
    : {
        executionMode: "tool-calling" as const,
        async interpret(): Promise<never> {
          throw new Error(
            "No production model configured. Configure XAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY.",
          );
        },
      };
}
