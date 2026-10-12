/**
 * Summarise arm results against the reference arm on the same dataset: AUROC with a bootstrap
 * interval, TPR at 1% and 5% FPR, cost per verdict, the cost ratio to the reference, and the
 * paired AUROC gap. An arm *matches* the reference when the paired gap's lower bound clears the
 * non-inferiority margin — the replication bar, stated as a number up front — both on the items
 * it scored and with the items it missed scored worst case.
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
  /** Spend per verdict delivered: failed items' spend included, their missing verdicts not. */
  costPerTrace: number;
  escalationRate: number;
  /** Against the reference, on the items it scored; absent for the reference itself. */
  vsReference?: {
    costRatio: number;
    /** On the items both scored. */
    delta: number;
    deltaCi: [number, number];
    /** With every item the arm missed scored worst case (see `pairUp`). */
    worstCaseDeltaCi: [number, number];
    /** Both intervals clear the margin, so missing items cannot buy a match. */
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
    costPerTrace: costPerVerdict(result.items),
    escalationRate: mean(result.items.map((item) => (item.escalated ? 1 : 0))),
  };
  if (reference && reference.arm !== result.arm) {
    summary.vsReference = compare(result, reference, summary.costPerTrace);
  }
  return summary;
}

interface Paired {
  labels: (0 | 1)[];
  arm: number[];
  ref: number[];
}

/**
 * The items the reference scored, paired with the arm's scores: once as scored (`both`, the
 * items the arm scored too), and once with each item the arm missed scored worst case
 * (`worstCase`: a missed positive below every score, a missed negative above every score).
 */
function pairUp(result: ArmResult, reference: ArmResult): { both: Paired; worstCase: Paired } {
  const refById = new Map(reference.items.map((item) => [item.id, item]));
  const scores = result.items.flatMap((item) => (item.score === null ? [] : [item.score]));
  const floor = Math.min(0, ...scores) - 1;
  const ceiling = Math.max(100, ...scores) + 1;
  const both: Paired = { labels: [], arm: [], ref: [] };
  const worstCase: Paired = { labels: [], arm: [], ref: [] };
  for (const item of result.items) {
    const other = refById.get(item.id);
    if (!other) throw new Error(`reference "${reference.arm}" has no item "${item.id}"`);
    if (other.score === null) continue;
    const worst = item.score ?? (item.label === 1 ? floor : ceiling);
    worstCase.labels.push(item.label);
    worstCase.arm.push(worst);
    worstCase.ref.push(other.score);
    if (item.score === null) continue;
    both.labels.push(item.label);
    both.arm.push(item.score);
    both.ref.push(other.score);
  }
  return { both, worstCase };
}

function compare(result: ArmResult, reference: ArmResult, costPerTrace: number) {
  const { both, worstCase } = pairUp(result, reference);
  const { delta, ci } = pairedAurocDelta(both.labels, both.arm, both.ref);
  const worst = pairedAurocDelta(worstCase.labels, worstCase.arm, worstCase.ref);
  const clears = (interval: [number, number]) => interval[0] > -NON_INFERIORITY_MARGIN;
  const refCost = costPerVerdict(reference.items);
  return {
    costRatio: costPerTrace > 0 ? refCost / costPerTrace : Number.POSITIVE_INFINITY,
    delta,
    deltaCi: ci,
    worstCaseDeltaCi: worst.ci,
    matches: clears(ci) && clears(worst.ci),
  };
}

/** Spend over verdicts delivered: a failed item's spend counts, its missing verdict does not. */
function costPerVerdict(items: readonly ItemResult[]): number {
  const delivered = items.filter((item) => item.score !== null).length;
  const spent = items.reduce((sum, item) => sum + item.costUsd, 0);
  return delivered === 0 ? Number.NaN : spent / delivered;
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
      ` ${vs ? verdict(vs) : "—"} |`
    );
  });
  return [header, ...rows].join("\n");
}

function verdict(vs: NonNullable<ArmSummary["vsReference"]>): string {
  if (vs.matches) return "yes";
  return vs.deltaCi[0] > -NON_INFERIORITY_MARGIN ? "no (missing items)" : "no";
}
