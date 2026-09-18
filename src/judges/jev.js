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

import { postJson } from "../backends/transport.js";

const API_URL = "https://api.typesafe.ai/v1/systemone";

/**
 * @param {object} config
 * @param {string} config.apiKey  a TypeSafe API key.
 * @param {string} [config.model]  "jev-latest" (default) or a pinned id like "jev-1.13.0" —
 *   pin when you have tuned thresholds, since an alias moves under you.
 */
export function jevJudge({ apiKey, model = "jev-latest" }) {
  if (!apiKey) throw new TypeError("jevJudge({apiKey}): apiKey is required");

  async function judge({ state, questions, signal }) {
    const reply = await postJson(API_URL, {
      headers: { authorization: `Bearer ${apiKey}` },
      body: { model, state, questions },
      signal,
      label: "jev",
    });
    if (!reply || typeof reply.answers !== "object") {
      throw new Error(`jev reply carried no answers: ${JSON.stringify(reply).slice(0, 200)}`);
    }
    return reply;
  }
  judge.model = model;
  return judge;
}
