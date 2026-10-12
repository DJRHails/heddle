/**
 * Price a live eval before paying for it: every arm runs through the real harness against a
 * backend that answers instantly and meters an *estimated* usage — input tokens at characters
 * ÷ 4 (prompt plus system), output at a fixed allowance — so the projection covers the exact
 * calls each arm makes (ensemble samples, long-read chunks, schema shapes). The backend answers
 * every score at the middle of the scale, so the cascade escalates every item: its line is an
 * upper bound, and the real cost scales with the escalation rate the live run reports.
 *
 *   node evals/estimate.ts <dataset.jsonl ...>
 */

import { basename } from "node:path";

import type { Backend } from "../src/index.ts";
import { evaluateArm } from "./harness.ts";
import { readItems } from "./items.ts";
import { ARMS } from "./monitors.ts";

const CHARS_PER_TOKEN = 4;
const OUTPUT_TOKENS = 300;

/** A mid-scale answer in whatever shape the arm's schema asks for. */
function answerFor(schema: unknown): unknown {
  const text = JSON.stringify(schema ?? null);
  if (text.includes('"probabilities"')) {
    const keys = Object.keys(
      ((schema as { properties: { probabilities: { properties: object } } }).properties
        .probabilities.properties) ?? {},
    );
    return { reasoning: "", probabilities: Object.fromEntries(keys.map((key) => [key, 0.5])) };
  }
  if (text.includes('"reply"')) {
    return { reply: text.includes('"score"') ? { reasoning: "", score: 50 } : "noted" };
  }
  return { reasoning: "", score: 50 };
}

const estimating: Backend = async ({ prompt, system, schema, model, meter }) => {
  meter?.({
    model: model ?? "claude-haiku-4-5",
    inputTokens: Math.ceil((prompt.length + (system?.length ?? 0)) / CHARS_PER_TOKEN),
    outputTokens: OUTPUT_TOKENS,
  });
  return schema ? answerFor(schema) : "noted";
};

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: node evals/estimate.ts <dataset.jsonl ...>");
  process.exit(2);
}

const totals = new Map<string, number>();
console.log("| dataset | n | arm | est. $/trace | est. $ total |\n| --- | --- | --- | --- | --- |");
for (const path of paths) {
  const items = readItems(path);
  const dataset = basename(path).replace(/\.jsonl$/, "");
  for (const arm of ARMS) {
    const result = await evaluateArm(dataset, items, arm, { backend: estimating, resume: false });
    const total = result.items.reduce((sum, item) => sum + item.costUsd, 0);
    totals.set(arm.name, (totals.get(arm.name) ?? 0) + total);
    console.log(
      `| ${dataset} | ${items.length} | ${arm.name} | $${(total / items.length).toPrecision(3)} |` +
        ` $${total.toFixed(2)} |`,
    );
  }
}
const grand = [...totals.values()].reduce((sum, t) => sum + t, 0);
console.log(`\nall arms, all datasets: $${grand.toFixed(2)}`);
for (const [arm, total] of totals) console.log(`  ${arm}: $${total.toFixed(2)}`);
