/** Every benchmark converter, by dataset name. */

import { AGENT_SAFETY } from "./agent-safety.ts";
import type { Benchmark } from "./benchmark.ts";
import { LINUXARENA } from "./linuxarena.ts";
import { MRT } from "./mrt.ts";
import { RESEARCH_ARENA } from "./research-arena.ts";

export const BENCHMARKS: readonly Benchmark[] = [
  ...MRT,
  ...LINUXARENA,
  ...RESEARCH_ARENA,
  ...AGENT_SAFETY,
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
