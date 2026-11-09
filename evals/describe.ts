/**
 * Describe converted datasets without calling a model: size, transcript length, how well
 * transcript length alone separates the classes (a floor any monitor must clear, and a check on
 * the converter), and the AUROC of every verdict set a benchmark ships, on the items it covers.
 *
 *   node evals/describe.ts <dataset.jsonl ...>
 *
 * Prints one markdown table. Shipped AUROCs come with their per-class counts: they are
 * upstream's monitors on this sample, not runs of ours.
 */

import { basename } from "node:path";

import { readItems, type MonitorItem } from "./items.ts";
import { auroc, type Scored } from "./metrics.ts";

/** Shipped verdict sets covering fewer items than this per class are not scored. */
const MIN_PER_CLASS = 20;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function shippedScores(item: MonitorItem): Record<string, number> {
  const scores = item.meta?.shippedScores;
  return typeof scores === "object" && scores !== null ? (scores as Record<string, number>) : {};
}

/** Each shipped verdict set's AUROC and per-class coverage, best covered first. */
function shipped(items: readonly MonitorItem[]): string {
  const byMonitor = new Map<string, Scored[]>();
  for (const item of items) {
    for (const [monitor, score] of Object.entries(shippedScores(item))) {
      const scored = byMonitor.get(monitor) ?? [];
      scored.push({ score, label: item.label });
      byMonitor.set(monitor, scored);
    }
  }
  const rows = [...byMonitor].flatMap(([monitor, scored]) => {
    const positives = scored.filter((s) => s.label === 1).length;
    const negatives = scored.length - positives;
    if (Math.min(positives, negatives) < MIN_PER_CLASS) return [];
    const text = `${monitor} ${auroc(scored).toFixed(3)} (${positives}/${negatives})`;
    return [{ count: scored.length, text }];
  });
  rows.sort((a, b) => b.count - a.count);
  return rows.map((row) => row.text).join("; ") || "—";
}

console.log(
  "| dataset | items (positive) | median chars | length-only AUROC |" +
    " shipped monitor AUROC (positives/negatives scored) |\n| --- | --- | --- | --- | --- |",
);
for (const path of process.argv.slice(2)) {
  const items = readItems(path);
  const positives = items.filter((item) => item.label === 1).length;
  const lengths = items.map((item) => ({ score: item.transcript.length, label: item.label }));
  console.log(
    `| ${basename(path, ".jsonl")} | ${items.length} (${positives}) |` +
      ` ${median(items.map((item) => item.transcript.length)).toLocaleString("en-US")} |` +
      ` ${auroc(lengths).toFixed(2)} | ${shipped(items)} |`,
  );
}
