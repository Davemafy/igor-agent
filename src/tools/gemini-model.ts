import { ModelRequestBudgetError } from "./model-budget";
import { ModelToolProtocolError } from "./model-tool-protocol-error";
import { ProviderHttpError } from "../core/interpretation-failure";
import { readModelResponse } from "./response-body";
import { z } from "zod";
import { ToolCallingModel } from "./tool-model";

const Message = z.object({
  role: z.string().optional(),
  content: z.string().optional(),
  type: z.string().optional(),
  name: z.string().optional(),
  call_id: z.string().optional(),
  output: z.string().optional(),
  geminiContent: z.record(z.string(), z.unknown()).optional(),
});

const Function = z.object({
  name: z.enum([
    "update_brief",
    "inspect_candidates",
    "submit_selection",
    "route_conversation",
    "submit_research_answer",
    "compose_draft",
    "choose_research_step",
    "choose_agent_action",
    "interpret_agent_requirements",
  ]),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
});

const ResponseSchema = z.object({
  modelVersion: z.string().optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().int().nonnegative().optional(),
      candidatesTokenCount: z.number().int().nonnegative().optional(),
      totalTokenCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
  candidates: z
    .array(
      z.object({
        finishReason: z.literal("STOP"),
        content: z
          .object({
            role: z.literal("model"),
            parts: z.array(
              z
                .object({
                  functionCall: z
                    .object({
                      name: z.string(),
                      id: z.string().optional(),
                      args: z.record(z.string(), z.unknown()).default({}),
                    })
                    .optional(),
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      }),
    )
    .length(1),
});

/** Same bounded capability protocol as the OpenAI adapter; no model-directed URLs. */
export class GeminiModel extends ToolCallingModel {
  override timeoutMs = 80000;

  usage: { model: string; input?: number; output?: number; total?: number }[] =
    [];

  protected override async call(
    input: unknown[],
    tools: unknown[],
    timeoutMs = 75000,
  ) {
    if (!this.key || !/^gemini-[a-z0-9.-]+$/.test(this.model)) {
      throw new Error("Gemini provider is not configured safely.");
    }

    if (this.calls >= this.maxCalls) {
      throw new ModelRequestBudgetError();
    }

    const functions = tools.map((tool) => Function.parse(tool));

    if (functions.length !== 1) {
      throw new Error("Exactly one allowed tool per step.");
    }

    const contents: unknown[] = [];
    const system: string[] = [];

    for (const raw of input) {
      const item = Message.parse(raw);

      if (item.role === "system" && item.content) {
        system.push(item.content);
      } else if (item.role === "user" && item.content) {
        contents.push({ role: "user", parts: [{ text: item.content }] });
      } else if (item.type === "function_call" && item.geminiContent) {
        // Preserve provider signatures and IDs when sending the next turn.
        contents.push(item.geminiContent);
      } else if (
        item.type === "function_call_output" &&
        item.call_id &&
        item.output
      ) {
        const previous = input
          .map((x) => Message.parse(x))
          .find(
            (x) => x.call_id === item.call_id && x.type === "function_call",
          );

        if (!previous?.name) {
          throw new Error("Unmatched model tool result.");
        }

        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: previous.name,
                id: item.call_id,
                response: { result: JSON.parse(item.output) },
              },
            },
          ],
        });
      } else {
        throw new Error("Unsupported model conversation item.");
      }
    }

    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: system.join("\n") }] },
      contents,
      tools: [
        {
          functionDeclarations: functions.map((f) => ({
            name: f.name,
            description: f.description,
            parametersJsonSchema: f.parameters,
          })),
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: functions.map((f) => f.name),
        },
      },
      generationConfig: { maxOutputTokens: 6000, temperature: 0 },
    });

    if (Buffer.byteLength(body) > 200000) {
      throw new Error("Model input size budget reached.");
    }

    this.calls++;
    let response: Response;

    try {
      response = await this.transport(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.key,
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch {
      throw new Error("Gemini request failed or timed out safely; no retry.");
    }

    if (!response.ok) {
      const detail = await readModelResponse(response).catch(() => "");
      throw new ProviderHttpError("Gemini", response.status, detail);
    }

    const raw = await readModelResponse(response);

    if (raw.includes(this.key)) {
      throw new Error("Unsafe model response.");
    }

    const parsed = ResponseSchema.parse(JSON.parse(raw));
    const content = parsed.candidates[0].content;
    const calls = content.parts.flatMap((p) =>
      p.functionCall ? [p.functionCall] : [],
    );

    if (calls.length !== 1 || calls[0].name !== functions[0].name) {
      throw new ModelToolProtocolError("unexpected");
    }

    const selected = calls[0];
    const call = {
      type: "function_call",
      name: selected.name,
      call_id: selected.id ?? `gemini-call-${this.calls}`,
      arguments: JSON.stringify(selected.args),
      geminiContent: content,
    };
    this.usage.push({
      model: parsed.modelVersion ?? this.model,
      input: parsed.usageMetadata?.promptTokenCount,
      output: parsed.usageMetadata?.candidatesTokenCount,
      total: parsed.usageMetadata?.totalTokenCount,
    });

    return { call, output: [call] };
  }
}
