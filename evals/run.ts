/**
 * Run monitor arms over a dataset and print the comparison table.
 *
 *   ANTHROPIC_API_KEY=... node evals/run.ts <dataset.jsonl> [arm ...] [--limit N]
 *
 * With no arms named, every arm in evals/monitors.ts runs; the reference arm always runs, since
 * every other arm is measured against it. Journals land under .data/evals/journals/<dataset>/,
 * so a re-run replays every settled call (zero new spend) and resumes failed ones; results and
 * the markdown table land under .data/evals/results/<dataset>/.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import { anthropicBackend } from "../src/backends/anthropic.ts";
import { evaluateArm, type ArmResult } from "./harness.ts";
import { readItems } from "./items.ts";
import { ARMS, armByName } from "./monitors.ts";
import { markdownTable, summariseArm } from "./report.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: "string" },
    concurrency: { type: "string", default: "8" },
  },
});

const [datasetPath, ...armNames] = positionals;
if (!datasetPath) {
  console.error("usage: node evals/run.ts <dataset.jsonl> [arm ...] [--limit N]");
  process.exit(2);
}
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("set ANTHROPIC_API_KEY");
  process.exit(2);
}

const dataset = basename(datasetPath).replace(/\.jsonl$/, "");
const all = readItems(datasetPath);
const items = values.limit ? all.slice(0, Number(values.limit)) : all;
const [reference] = ARMS;
if (!reference) throw new Error("evals/monitors.ts defines no arms");
const arms = [reference, ...armNames.map(armByName).filter((arm) => arm !== reference)];
const selected = armNames.length === 0 ? ARMS : arms;

const journals = join(".data/evals/journals", dataset);
const results = join(".data/evals/results", dataset);
mkdirSync(journals, { recursive: true });
mkdirSync(results, { recursive: true });

const backend = anthropicBackend({ apiKey });
const settled: ArmResult[] = [];
for (const arm of selected) {
  const result = await evaluateArm(dataset, items, arm, {
    backend,
    journalPath: join(journals, `${arm.name}.jsonl`),
    concurrency: Number(values.concurrency),
  });
  writeFileSync(join(results, `${arm.name}.json`), `${JSON.stringify(result, null, 2)}\n`);
  settled.push(result);
}

const [referenceResult] = settled;
const table = markdownTable(
  `${dataset} (n=${items.length})`,
  settled.map((result) => summariseArm(result, referenceResult)),
);
writeFileSync(join(results, "table.md"), `${table}\n`);
console.log(table);
