/**
 * List prices (Anthropic first-party API, USD per million tokens, read 2026-10-12) for the
 * models the eval arms use. A usage record naming a model missing here throws: an unpriced
 * call silently costing $0 would flatter exactly the arm that made it.
 *
 * Cache reads bill at 0.1x input and 5-minute cache writes at 1.25x. Claude Haiku 5.5 has two
 * rate cards chosen per request by prompt length (over 100K tokens: $0.50 / $2.50).
 */

import type { Usage } from "../src/index.ts";

interface RateCard {
  input: number;
  output: number;
}

interface ModelPrice {
  base: RateCard;
  /** A second card for prompts longer than `overTokens`. */
  long?: RateCard & { overTokens: number };
}

const PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-8": { base: { input: 5, output: 25 } },
  "claude-opus-5": { base: { input: 5, output: 25 } },
  "claude-opus-5-5": { base: { input: 4, output: 20 } },
  "claude-sonnet-5-5": { base: { input: 2, output: 10 } },
  "claude-sonnet-4-6": { base: { input: 3, output: 15 } },
  "claude-haiku-4-5": { base: { input: 1, output: 5 } },
  "claude-haiku-4-5-20251001": { base: { input: 1, output: 5 } },
  "claude-haiku-5-5": {
    base: { input: 0.1, output: 0.5 },
    long: { input: 0.5, output: 2.5, overTokens: 100_000 },
  },
};

const CACHE_READ = 0.1;
const CACHE_WRITE = 1.25;

/** Dollars for one provider request. */
export function requestCost(usage: Usage): number {
  const price = PRICES[usage.model];
  if (!price) {
    throw new Error(
      `no price for model "${usage.model}" — add it to evals/pricing.ts before running an arm on it`,
    );
  }
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const promptTokens = usage.inputTokens + read + write;
  const card = price.long && promptTokens > price.long.overTokens ? price.long : price.base;
  const inputDollars =
    usage.inputTokens * card.input + read * card.input * CACHE_READ + write * card.input * CACHE_WRITE;
  return (inputDollars + usage.outputTokens * card.output) / 1_000_000;
}

export function usageCost(usage: readonly Usage[]): number {
  return usage.reduce((sum, entry) => sum + requestCost(entry), 0);
}
