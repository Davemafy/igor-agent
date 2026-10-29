import { expect, it } from "vitest";
import { GeminiModel } from "../../src/tools/gemini-model";
import { freshLiveTask } from "../../src/data/live-task";
import { readModelResponse } from "../../src/tools/response-body";

const cases = [
  { name: "ordinary greeting", text: "hey", intent: "conversation" },
  {
    name: "cultural work request",
    text: "I run a 100-capacity space in Brooklyn. Our community loves Sade, Radiohead and Wong Kar-wai films. Design an unexpected Saturday experience under $3,000 and save an editable proposal, schedule and partner pitch. Label unverified practical facts.",
    intent: "research",
  },
];

for (const sample of cases) {
  it(`routes ${sample.name} through the actual configured model adapter (LIVE, no Qloo)`, async () => {
    const key = process.env.GEMINI_API_KEY;

    if (!key) {
      throw Error("BLOCKED: authorized Gemini binding missing");
    }

    const id = process.env.GEMINI_MODEL || "gemini-3.5-flash";
    const observations: object[] = [];

    const transport: typeof fetch = async (url, init) => {
      const started = performance.now();
      const response = await fetch(url, init);
      let upstream: string | null = null;
      let categories: string[] = [];

      if (!response.ok) {
        try {
          const raw = await readModelResponse(response.clone());
          const status = JSON.parse(raw)?.error?.status;

          if (
            [
              "UNAVAILABLE",
              "RESOURCE_EXHAUSTED",
              "INVALID_ARGUMENT",
              "NOT_FOUND",
              "PERMISSION_DENIED",
              "UNAUTHENTICATED",
              "DEADLINE_EXCEEDED",
              "INTERNAL",
            ].includes(status)
          ) {
            upstream = status;
          }

          categories = [
            "overloaded",
            "capacity",
            "unavailable",
            "quota",
            "rate limit",
            "context",
            "schema",
            "unsupported",
          ].filter((word) => raw.toLowerCase().includes(word));
        } catch {
          /* Raw upstream bodies are never printed or persisted. */
        }
      }

      observations.push({
        model: id,
        httpStatus: response.status,
        latencyMs: Math.round(performance.now() - started),
        requestBytes: Buffer.byteLength(String(init?.body ?? "")),
        upstream,
        categories,
      });

      return response;
    };

    const model = new GeminiModel(key, id, transport, 2);

    try {
      const result = await model.routeConversation(
        sample.text,
        freshLiveTask("live-routing-check", "synthetic-owner"),
      );
      expect(result?.intent).toBe(sample.intent);
      expect(model.calls).toBe(1);
    } finally {
      console.log(
        "LIVE_ROUTING_PROTOCOL",
        JSON.stringify({
          case: sample.name,
          observations,
          modelCalls: model.calls,
          applicationAcceptance: false,
        }),
      );
    }
  });
}
