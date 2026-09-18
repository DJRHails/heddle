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

import { realClock } from "../determinism.js";
import { MAX_SCHEMA_RETRIES, schemaErrors } from "../schema.js";
import { postJson } from "./transport.js";

const API_URL = "https://api.anthropic.com/v1/messages";

const RETURN_VALUE_CONTRACT =
  "Your final message text is returned verbatim to a program as its data — output only the" +
  " answer itself, with no preamble, no meta-commentary, and no markdown fences unless the" +
  " answer is code.";

function postMessages(body, { apiKey, signal }) {
  return postJson(API_URL, {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body,
    signal,
    label: "anthropic",
  });
}

/**
 * @param {object} config
 * @param {string} config.apiKey
 * @param {string} [config.defaultModel] version-qualified model id used when a call names none.
 */
export function anthropicBackend({ apiKey, defaultModel = "claude-haiku-4-5-20251001" }) {
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
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    }

    const tool = {
      name: "structured_output",
      description: "Return your answer as structured data matching the schema exactly.",
      input_schema: schema,
    };
    const messages = [{ role: "user", content: prompt }];
    for (let attempt = 0; ; attempt += 1) {
      const reply = await postMessages(
        {
          model: resolvedModel,
          max_tokens: budget,
          system: system ?? "Answer by calling the structured_output tool.",
          messages,
          tools: [tool],
          tool_choice: { type: "tool", name: "structured_output" },
        },
        { apiKey, signal },
      );
      const call = reply.content.find((block) => block.type === "tool_use");
      const payload = call?.input;
      const errors =
        payload === undefined ? "no tool call in reply" : schemaErrors(schema, payload);
      if (!errors) return payload;
      if (attempt >= MAX_SCHEMA_RETRIES) {
        throw new Error(
          `structured output failed schema after ${attempt + 1} attempts: ${errors}`,
        );
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
  };
}
