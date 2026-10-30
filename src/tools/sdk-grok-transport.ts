import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import {
  APICallError,
  generateText,
  jsonSchema,
  tool,
  type ModelMessage,
} from "ai";
import { z } from "zod";
import { readModelResponse } from "./response-body";
import { ProviderHttpError } from "../core/interpretation-failure";
import { ModelToolProtocolError } from "./model-tool-protocol-error";

/** Keep Igor's validated decision protocol while the SDK owns provider I/O. */
export function sdkGrokTransport(
  key: string,
  transport: typeof fetch,
): typeof fetch {
  return sdkToolTransport(key, transport, "grok");
}

export function sdkToolTransport(
  key: string,
  transport: typeof fetch,
  provider: "grok" | "anthropic",
): typeof fetch {
  const configuration = {
    apiKey: key,
    fetch: async (url: RequestInfo | URL, options?: RequestInit) => {
      const response = await transport(url, { ...options, redirect: "error" });
      const raw = await readModelResponse(response).catch((error) => {
        if (!response.ok) {
          return "";
        }

        throw error;
      });

      if (!response.ok) {
        const diagnostic = new ProviderHttpError(
          provider === "grok" ? "Grok" : "Claude",
          response.status,
          raw,
        );

        // Preserve only fixed diagnostic keywords, never the provider body.
        return Response.json(
          {
            error: {
              message: [
                ...diagnostic.schemaKeywords,
                diagnostic.category ? `igor_error:${diagnostic.category}` : "",
              ].join(" "),
            },
          },
          { status: response.status },
        );
      }

      if (raw.includes(key)) {
        throw new Error("Unsafe model response.");
      }

      return new Response(raw, {
        status: response.status,
        headers: response.headers,
      });
    },
  };
  const xai = createOpenAICompatible({
    ...configuration,
    name: "xai",
    baseURL: "https://api.x.ai/v1",
    transformRequestBody: (body) => ({ ...body, parallel_tool_calls: false }),
  });
  const anthropic = createAnthropic(configuration);

  return async (_url, options) => {
    const request = z
      .object({
        model: z.string(),
        input: z.array(z.unknown()),
        tools: z.array(
          z.object({
            name: z.string(),
            description: z.string(),
            parameters: z.record(z.string(), z.unknown()),
            strict: z.boolean().optional(),
          }),
        ),
      })
      .parse(JSON.parse(String(options?.body)));
    const messages: ModelMessage[] = [];
    const instructions: string[] = [];
    const names = new Map<string, string>();

    for (const value of request.input) {
      const entry = z
        .object({
          role: z.enum(["system", "user", "assistant"]).optional(),
          content: z.string().optional(),
          type: z.string().optional(),
          name: z.string().optional(),
          call_id: z.string().optional(),
          arguments: z.string().optional(),
          output: z.string().optional(),
        })
        .passthrough()
        .parse(value);

      if (entry.role === "system" && entry.content !== undefined) {
        instructions.push(entry.content);
      } else if (entry.role && entry.content !== undefined) {
        messages.push({ role: entry.role, content: entry.content });
      } else if (
        entry.type === "function_call" &&
        entry.call_id &&
        entry.name
      ) {
        names.set(entry.call_id, entry.name);
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: entry.call_id,
              toolName: entry.name,
              input: JSON.parse(entry.arguments ?? "{}"),
            },
          ],
        });
      } else if (
        entry.type === "function_call_output" &&
        entry.call_id &&
        names.has(entry.call_id)
      ) {
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: entry.call_id,
              toolName: names.get(entry.call_id)!,
              output: { type: "text", value: entry.output ?? "" },
            },
          ],
        });
      } else {
        throw new Error("Unsupported model protocol input.");
      }
    }

    try {
      const result = await generateText({
        model:
          provider === "grok"
            ? xai.chatModel(request.model)
            : anthropic(request.model),
        instructions: instructions.join("\n"),
        messages,
        tools: Object.fromEntries(
          request.tools.map((definition) => [
            definition.name,
            tool({
              description: definition.description,
              inputSchema: jsonSchema(definition.parameters),
              strict: definition.strict ?? false,
              // Execution remains exclusively in Igor after full decision validation.
            }),
          ]),
        ),
        toolChoice: "required",
        maxRetries: 0,
        maxOutputTokens: 6000,
        abortSignal: options?.signal ?? undefined,
        providerOptions:
          provider === "grok"
            ? { xai: { parallelToolCalls: false } }
            : { anthropic: { disableParallelToolUse: true } },
      });

      if (result.finishReason !== "tool-calls") {
        throw new ModelToolProtocolError("missing-or-multiple");
      }

      return Response.json({
        status: "completed",
        output: result.toolCalls.map((call) => ({
          type: "function_call",
          name: call.toolName,
          call_id: call.toolCallId,
          arguments: JSON.stringify(call.input),
        })),
      });
    } catch (error) {
      if (
        APICallError.isInstance(error) &&
        error.statusCode &&
        error.statusCode >= 400
      ) {
        // Never copy provider bodies (which may include sensitive input) into errors.
        return new Response(error.responseBody ?? "", {
          status: error.statusCode,
        });
      }

      throw error;
    }
  };
}
