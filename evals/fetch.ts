/**
 * Convert external benchmarks into monitor-eval datasets.
 *
 *   node evals/fetch.ts <benchmark ...|all> [--per-class 150]
 *
 * Each benchmark is fetched at its pinned revision, converted to monitor items, and sampled to
 * at most `--per-class` items per label (deterministic by id hash), then written to
 * .data/evals/datasets/<benchmark>.jsonl with a one-line summary of what was kept.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { BENCHMARKS, benchmarkByName } from "./benchmarks/index.ts";
import { writeItems } from "./items.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "per-class": { type: "string", default: "150" } },
});
if (positionals.length === 0) {
  console.error(`usage: node evals/fetch.ts <${BENCHMARKS.map((b) => b.name).join("|")}|all>`);
  process.exit(2);
}
const perClass = Number(values["per-class"]);
const chosen = positionals.includes("all") ? BENCHMARKS : positionals.map(benchmarkByName);

const out = ".data/evals/datasets";
mkdirSync(out, { recursive: true });
for (const benchmark of chosen) {
  const { items, available } = await benchmark.fetch(perClass);
  const path = join(out, `${benchmark.name}.jsonl`);
  writeItems(path, items);
  const positives = items.filter((item) => item.label === 1).length;
  const chars = items.map((item) => item.transcript.length).sort((a, b) => a - b);
  const median = chars[Math.floor(chars.length / 2)] ?? 0;
  console.log(
    `${benchmark.name}: ${items.length}/${available} items (${positives} positive),` +
      ` median ${median} chars -> ${path}`,
  );
}
