/**
 * Run one monitor arm over a dataset as a single heddle run: a pipeline over the items, one
 * journal per (dataset, arm) so a re-run replays every settled call, and per-item cost from the
 * metered usage. Each item's stage runs inside an AsyncLocalStorage scope, so every call the
 * arm makes — live or replayed — is billed to the item that issued it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { run, type Backend, type CallReport } from "../src/index.ts";
import type { MonitorItem } from "./items.ts";
import type { Arm } from "./monitors.ts";
import { usageCost } from "./pricing.ts";

export interface ItemResult {
  id: string;
  task: string;
  label: 0 | 1;
  /** Null when the monitor could not score the item: no verdict, not benign. */
  score: number | null;
  escalated: boolean;
  calls: number;
  costUsd: number;
}

export interface ArmResult {
  dataset: string;
  arm: string;
  description: string;
  items: ItemResult[];
}

export interface EvaluateOptions {
  backend: Backend;
  /** Journal for this (dataset, arm); a re-run with `resume` replays it. */
  journalPath?: string;
  resume?: boolean;
  concurrency?: number;
}

interface Tally {
  calls: number;
  costUsd: number;
}

/** A call with no metered usage cannot be priced, and pricing it at $0 would flatter its arm. */
function unpriced(call: CallReport): Error {
  const how = call.replayed
    ? "replayed from a journal written before usage metering — delete the journal and re-run"
    : "the backend reported no usage — use a metering backend (anthropicBackend meters)";
  return new Error(`an ${call.kind} call has no usage to price: ${how}`);
}

export async function evaluateArm(
  dataset: string,
  items: readonly MonitorItem[],
  arm: Arm,
  options: EvaluateOptions,
): Promise<ArmResult> {
  const scope = new AsyncLocalStorage<Tally>();
  const tallies = new Map<string, Tally>(items.map((item) => [item.id, { calls: 0, costUsd: 0 }]));
  // A throw inside onCall would surface as a failed agent call (a null verdict), so problems
  // are collected here and raised once the run has settled.
  const problems: Error[] = [];
  const onCall = (call: CallReport) => {
    const tally = scope.getStore();
    if (!tally) {
      problems.push(new Error("a model call ran outside any item's scope"));
      return;
    }
    if (call.usage.length === 0 && call.status === "ok") problems.push(unpriced(call));
    tally.calls += 1;
    try {
      tally.costUsd += usageCost(call.usage);
    } catch (error) {
      problems.push(error as Error);
    }
  };
  const verdicts = await run(
    (w) =>
      w.pipeline(items, (item) =>
        scope.run(tallies.get(item.id) as Tally, () => arm.monitor(w, item)),
      ),
    {
      backend: options.backend,
      journalPath: options.journalPath,
      resume: options.resume ?? true,
      concurrency: options.concurrency,
      maxAgents: Number.MAX_SAFE_INTEGER,
      onCall,
    },
  );
  if (problems.length > 0) {
    throw new AggregateError(problems, `${arm.name} on ${dataset}: ${problems[0]?.message}`);
  }
  return {
    dataset,
    arm: arm.name,
    description: arm.description,
    items: items.map((item, index) => {
      const verdict = verdicts[index] ?? null;
      const tally = tallies.get(item.id) as Tally;
      return {
        id: item.id,
        task: item.task,
        label: item.label,
        score: verdict?.score ?? null,
        escalated: verdict?.escalated ?? false,
        calls: tally.calls,
        costUsd: tally.costUsd,
      };
    }),
  };
}
