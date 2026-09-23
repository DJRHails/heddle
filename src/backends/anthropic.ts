/**
 * The Anthropic Messages API backend: zero-SDK, fetch only.
 *
 * Without a schema, the agent's final text is the return value — and the system prompt says so
 * explicitly, or the model answers "Done." instead of data. With a schema, the model is forced
 * through a structured_output tool whose input_schema is the caller's JSON Schema; the payload
 * is validated here (ajv) and a shape mismatch retries the model with the validation errors
 * appended, bounded by MAX_SCHEMA_RETRIES. Transport failures (429/5xx/network) retry with
 * backoff, also bounded; after the bounds the call throws, which agent() records and resolves
 * to null.
 */

import { realClock } from "../determinism.ts";
import { MAX_SCHEMA_RETRIES, schemaErrors } from "../schema.ts";
import type { Backend, JsonSchema } from "../types.ts";
import { postJson } from "./transport.ts";

const API_URL = "https://api.anthropic.com/v1/messages";

const RETURN_VALUE_CONTRACT =
  "Your final message text is returned verbatim to a program as its data — output only the" +
  " answer itself, with no preamble, no meta-commentary, and no markdown fences unless the" +
  " answer is code.";

/** The parts of a Messages API reply this backend reads. */
interface MessagesReply {
  content: ContentBlock[];
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: string };

type MessageParam = { role: "user" | "assistant"; content: string | unknown[] };

function postMessages(
  body: Record<string, unknown>,
  { apiKey, signal }: { apiKey: string; signal: AbortSignal | undefined },
): Promise<MessagesReply> {
  return postJson<MessagesReply>(API_URL, {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body,
    signal,
    label: "anthropic",
  });
}

function isText(block: ContentBlock): block is { type: "text"; text: string } {
  return block.type === "text";
}

function isToolUse(block: ContentBlock): block is { type: "tool_use"; id: string; input: unknown } {
  return block.type === "tool_use";
}

export interface AnthropicConfig {
  apiKey: string;
  /** Version-qualified model id used when a call names none. */
  defaultModel?: string;
}

export function anthropicBackend({
  apiKey,
  defaultModel = "claude-haiku-4-5-20251001",
}: AnthropicConfig): Backend {
  if (!apiKey) throw new TypeError("anthropicBackend({apiKey}): apiKey is required");
  // Touch the real clock once so the reference exists before determinism guards install.
  void realClock.now;

  return async function backend({ prompt, system, schema, model, maxTokens, signal }) {
    const resolvedModel = model ?? defaultModel;
    const budget = maxTokens ?? 2048;

    if (!schema) {
      const body = {
        model: resolvedModel,
        max_tokens: budget,
        system: system ? `${system}\n\n${RETURN_VALUE_CONTRACT}` : RETURN_VALUE_CONTRACT,
        messages: [{ role: "user", content: prompt }],
      };
      const reply = await postMessages(body, { apiKey, signal });
      return reply.content
        .filter(isText)
        .map((block) => block.text)
        .join("\n")
        .trim();
    }
    return structured({ prompt, system, schema, model: resolvedModel, budget, apiKey, signal });
  };
}

async function structured({
  prompt,
  system,
  schema,
  model,
  budget,
  apiKey,
  signal,
}: {
  prompt: string;
  system: string | undefined;
  schema: JsonSchema;
  model: string;
  budget: number;
  apiKey: string;
  signal: AbortSignal | undefined;
}): Promise<unknown> {
  const tool = {
    name: "structured_output",
    description: "Return your answer as structured data matching the schema exactly.",
    input_schema: schema,
  };
  const messages: MessageParam[] = [{ role: "user", content: prompt }];
  for (let attempt = 0; ; attempt += 1) {
    const reply = await postMessages(
      {
        model,
        max_tokens: budget,
        system: system ?? "Answer by calling the structured_output tool.",
        messages,
        tools: [tool],
        tool_choice: { type: "tool", name: "structured_output" },
      },
      { apiKey, signal },
    );
    const call = reply.content.find(isToolUse);
    const payload = call?.input;
    const errors = payload === undefined ? "no tool call in reply" : schemaErrors(schema, payload);
    if (!errors) return payload;
    if (attempt >= MAX_SCHEMA_RETRIES) {
      throw new Error(`structured output failed schema after ${attempt + 1} attempts: ${errors}`);
    }
    messages.push(
      { role: "assistant", content: reply.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: call?.id ?? "missing",
            content:
              `Your answer did not match the schema: ${errors}. Call the tool again with a` +
              " conforming payload.",
            is_error: true,
          },
        ],
      },
    );
  }
}
