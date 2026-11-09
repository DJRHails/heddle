/**
 * What a benchmark converter provides, and the deterministic sampling every converted dataset
 * goes through. A converter pins its upstream revision and states its licence; `fetch` returns
 * every item it can build, and `evals/fetch.ts` samples a class-balanced subset so an eval's
 * spend is bounded and the same on every machine.
 */

import { createHash } from "node:crypto";

import type { MonitorItem } from "../items.ts";

export interface Benchmark {
  /** The dataset name: file stem under .data/evals/datasets/ and the report heading. */
  name: string;
  /** Paper and data location, for the README's provenance table. */
  provenance: string;
  /** The upstream licence as published (or "none stated"). */
  licence: string;
  /**
   * The class-balanced sample (`balancedSample` over every candidate) and how many candidates
   * there were. Converters whose upstream is large sample candidate keys before downloading.
   */
  fetch(perClass: number): Promise<Fetched>;
}

export interface Fetched {
  items: MonitorItem[];
  available: number;
}

function rank(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

/**
 * At most `perClass` items of each label, chosen by the hash of their id: deterministic,
 * independent of upstream row order, and stable when upstream appends rows. Output is ordered
 * by that hash too, so the two classes interleave. Works on candidate keys as well as items.
 */
export function balancedSample<T extends { id: string; label: 0 | 1 }>(
  items: readonly T[],
  perClass: number,
): T[] {
  const ranked = [...items].sort((a, b) => (rank(a.id) < rank(b.id) ? -1 : 1));
  const taken = { 0: 0, 1: 0 };
  return ranked.filter((item) => {
    if (taken[item.label] >= perClass) return false;
    taken[item.label] += 1;
    return true;
  });
}

/** Sample an already-built item list (the converters whose upstream is small). */
export function sampled(items: readonly MonitorItem[], perClass: number): Fetched {
  return { items: balancedSample(items, perClass), available: items.length };
}

/** Run `task` over `inputs` with at most `limit` in flight, preserving order. */
export async function mapLimited<In, Out>(
  inputs: readonly In[],
  limit: number,
  task: (input: In) => Promise<Out>,
): Promise<Out[]> {
  const results: Out[] = [];
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const index = next;
      next += 1;
      results[index] = await task(inputs[index] as In);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
  return results;
}
