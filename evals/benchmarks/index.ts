/** Every benchmark converter, by dataset name. */

import { AGENT_SAFETY } from "./agent-safety.ts";
import { APPS_BACKDOORS } from "./apps-backdoors.ts";
import { ATBENCH_RELEASES } from "./atbench.ts";
import { AUTOMONITOR_BENCH } from "./automonitor-bench.ts";
import type { Benchmark } from "./benchmark.ts";
import { COT_RED_HANDED } from "./cot-red-handed.ts";
import { LINUXARENA } from "./linuxarena.ts";
import { MRT } from "./mrt.ts";
import { RESEARCH_ARENA } from "./research-arena.ts";

export const BENCHMARKS: readonly Benchmark[] = [
  ...MRT,
  ...LINUXARENA,
  ...RESEARCH_ARENA,
  ...AGENT_SAFETY,
  ...ATBENCH_RELEASES,
  ...AUTOMONITOR_BENCH,
  ...COT_RED_HANDED,
  ...APPS_BACKDOORS,
];

export function benchmarkByName(name: string): Benchmark {
  const benchmark = BENCHMARKS.find((candidate) => candidate.name === name);
  if (!benchmark) {
    throw new Error(
      `unknown benchmark "${name}"; known: ${BENCHMARKS.map((b) => b.name).join(", ")}`,
    );
  }
  return benchmark;
}
