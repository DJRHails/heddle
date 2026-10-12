/** Every benchmark converter, by dataset name. */

import { AGENT_SAFETY } from "./agent-safety.ts";
import type { Benchmark } from "./benchmark.ts";
import { MRT } from "./mrt.ts";

export const BENCHMARKS: readonly Benchmark[] = [...MRT, ...AGENT_SAFETY];

export function benchmarkByName(name: string): Benchmark {
  const benchmark = BENCHMARKS.find((candidate) => candidate.name === name);
  if (!benchmark) {
    throw new Error(
      `unknown benchmark "${name}"; known: ${BENCHMARKS.map((b) => b.name).join(", ")}`,
    );
  }
  return benchmark;
}
