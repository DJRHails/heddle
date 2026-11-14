/**
 * The Jev judge: TypeSafe's System One model, called directly over its HTTP API.
 *
 * Jev does not generate text; it answers typed questions about a state — noul (yes/no),
 * choice (one of your labels), score (a rubric level) — with calibrated probabilities, in one
 * parallel pass rather than token by token. That makes it the natural leaf for decisions: no
 * parsing, no schema retries, no hallucinated labels (the answer is constrained to the options
 * by construction). Contract: https://docs.typesafe.ai/api
 *
 * A judge is a plain async function ({state, questions, signal}) -> {model, answers, usage},
 * with a `model` property naming the model for the journal key. Transport failures retry with
 * backoff (shared with the Anthropic backend); after the bound the call throws, which judge()
 * journals and propagates — a decision that cannot be obtained is an error, not a null.
 */

import { postJson } from "../backends/transport.ts";
import type { Judge, JudgeRequest, JudgeResponse, Usage } from "../types.ts";

const API_URL = "https://api.typesafe.ai/v1/systemone";

export interface JevConfig {
  /** A TypeSafe API key. */
  apiKey: string;
  /**
   * "jev-latest" (default) or a pinned id like "jev-1.13.0" — pin when you have tuned
   * thresholds, since an alias moves under you.
   */
  model?: string;
  /** Optional input-only USD/M-token rate. Caller-supplied estimate, not a receipt. */
  inputUsdPerMillion?: number;
  /** Optional pipeline stage to retain with metered usage. */
  stage?: string;
}

export function judge({ apiKey, model = "jev-latest", inputUsdPerMillion, stage }: JevConfig): Judge {
  if (!apiKey) throw new TypeError("judge({apiKey}): apiKey is required");
  if (inputUsdPerMillion !== undefined &&
    (!Number.isFinite(inputUsdPerMillion) || inputUsdPerMillion < 0)) {
    throw new TypeError("judge: inputUsdPerMillion must be finite and nonnegative");
  }

  async function judge({ state, questions, signal, meter }: JudgeRequest): Promise<JudgeResponse> {
    const reply = await postJson<JudgeResponse | null>(API_URL, {
      headers: { authorization: `Bearer ${apiKey}` },
      body: { model, state, questions },
      signal,
      label: "jev",
    });
    if (reply && reply.usage && typeof reply.usage === "object") {
      const usage = reply.usage as { input_tokens?: number; output_tokens?: number };
      if (typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens) &&
        usage.input_tokens >= 0 && typeof usage.output_tokens === "number" &&
        Number.isFinite(usage.output_tokens) && usage.output_tokens >= 0) {
        const entry: Usage = {
          model: reply.model ?? model, provider: "typesafe", stage,
          inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
        };
        if (inputUsdPerMillion !== undefined) entry.cost = {
          usd: usage.input_tokens * inputUsdPerMillion / 1_000_000,
          source: "estimate", basis: `caller-supplied input-only USD ${inputUsdPerMillion}/M tokens`,
        };
        meter?.(entry);
      }
    }
    if (!reply || !reply.answers || typeof reply.answers !== "object") {
      throw new Error(`jev reply carried no answers: ${JSON.stringify(reply).slice(0, 200)}`);
    }
    return reply;
  }
  return Object.assign(judge, { model });
}
