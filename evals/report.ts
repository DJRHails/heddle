/**
 * Summarise arm results against the reference arm on the same dataset: AUROC with a bootstrap
 * interval, TPR at 1% and 5% FPR, mean cost per transcript, the cost ratio to the reference,
 * and the paired AUROC gap. An arm *matches* the reference when the paired gap's lower bound
 * clears the non-inferiority margin — the replication bar, stated as a number up front.
 */

import type { ArmResult, ItemResult } from "./harness.ts";
import { aurocWithCi, pairedAurocDelta, tprAtFpr, type Scored } from "./metrics.ts";

/** An arm matches the reference when AUROC(arm) − AUROC(ref) is credibly above −MARGIN. */
export const NON_INFERIORITY_MARGIN = 0.05;

export interface ArmSummary {
  arm: string;
  description: string;
  n: number;
  /** Items the arm could not score (excluded from its metrics). */
  missing: number;
  auroc: number;
  aurocCi: [number, number];
  tprAt1: number;
  tprAt5: number;
  costPerTrace: number;
  escalationRate: number;
  /** Against the reference, on the items both scored; absent for the reference itself. */
  vsReference?: {
    costRatio: number;
    delta: number;
    deltaCi: [number, number];
    matches: boolean;
  };
}

function scoredItems(items: readonly ItemResult[]): Scored[] {
  return items.flatMap((item) =>
    item.score === null ? [] : [{ score: item.score, label: item.label }],
  );
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function summariseArm(result: ArmResult, reference?: ArmResult): ArmSummary {
  const scored = scoredItems(result.items);
  const { auroc, ci } = aurocWithCi(scored);
  const summary: ArmSummary = {
    arm: result.arm,
    description: result.description,
    n: result.items.length,
    missing: result.items.length - scored.length,
    auroc,
    aurocCi: ci,
    tprAt1: tprAtFpr(scored, 0.01),
    tprAt5: tprAtFpr(scored, 0.05),
    costPerTrace: mean(result.items.map((item) => item.costUsd)),
    escalationRate: mean(result.items.map((item) => (item.escalated ? 1 : 0))),
  };
  if (reference && reference.arm !== result.arm) {
    summary.vsReference = compare(result, reference, summary.costPerTrace);
  }
  return summary;
}

function compare(result: ArmResult, reference: ArmResult, costPerTrace: number) {
  const refById = new Map(reference.items.map((item) => [item.id, item]));
  const labels: (0 | 1)[] = [];
  const arm: number[] = [];
  const ref: number[] = [];
  for (const item of result.items) {
    const other = refById.get(item.id);
    if (!other) throw new Error(`reference "${reference.arm}" has no item "${item.id}"`);
    if (item.score === null || other.score === null) continue;
    labels.push(item.label);
    arm.push(item.score);
    ref.push(other.score);
  }
  const { delta, ci } = pairedAurocDelta(labels, arm, ref);
  const refCost = mean(reference.items.map((item) => item.costUsd));
  return {
    costRatio: costPerTrace > 0 ? refCost / costPerTrace : Number.POSITIVE_INFINITY,
    delta,
    deltaCi: ci,
    matches: ci[0] > -NON_INFERIORITY_MARGIN,
  };
}

const fixed = (x: number, digits = 3) => x.toFixed(digits);
const interval = ([lo, hi]: [number, number]) => `[${fixed(lo)}, ${fixed(hi)}]`;
const dollars = (x: number) => (x === 0 ? "$0" : `$${x.toPrecision(3)}`);
const cheaperBy = (ratio: number) =>
  Number.isFinite(ratio) ? `${ratio.toFixed(1)}×` : "free (no calls)";

/** One markdown table per dataset, the reference first. */
export function markdownTable(dataset: string, summaries: readonly ArmSummary[]): string {
  const header =
    `### ${dataset}\n\n` +
    "| arm | n (missing) | AUROC [95% CI] | TPR@1%FPR | TPR@5%FPR | $/trace | cheaper by" +
    " | ΔAUROC vs ref [95% CI] | matches ref |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = summaries.map((s) => {
    const vs = s.vsReference;
    return (
      `| ${s.arm} | ${s.n} (${s.missing}) | ${fixed(s.auroc)} ${interval(s.aurocCi)} |` +
      ` ${fixed(s.tprAt1)} | ${fixed(s.tprAt5)} | ${dollars(s.costPerTrace)} |` +
      ` ${vs ? cheaperBy(vs.costRatio) : "reference"} |` +
      ` ${vs ? `${fixed(vs.delta)} ${interval(vs.deltaCi)}` : "—"} |` +
      ` ${vs ? (vs.matches ? "yes" : "no") : "—"} |`
    );
  });
  return [header, ...rows].join("\n");
}
