/**
 * The runner: execute a script file (or function) and return its return value.
 *
 * A script is an ordinary ES module exporting `default async function (w) { ... }`; it receives
 * the api object `{ agent, parallel, pipeline, judge, feels, match, args }` (see `Workflow`) and
 * whatever it returns is run()'s result. Two model seams: `backend` writes (agent), `judge`
 * decides (feels/match); when no judge is given, the backend emulates one through structured
 * output. There is no sandbox: the script is trusted code running in-process with real stack
 * traces and a debugger that works (see README — node:vm is not a security boundary, so it
 * bought nothing but bare-realm footguns). Determinism guards are installed for the duration:
 * Math.random(), Date.now(), bare Date() and argless new Date() throw; new Date(x) works.
 */

import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { installDeterminismGuards } from "./determinism.ts";
import { Journal } from "./journal.ts";
import { llmJudge } from "./judges/llm.ts";
import { makeApi } from "./primitives.ts";
import type { Backend, Judge, Script } from "./types.ts";

export interface RunOptions<Args = unknown> {
  /** Writes: the model call behind `agent`. Required. */
  backend: Backend;
  /** Decides: Jev's `judge` (`heddle/judges/jev`), or omit to emulate one over the backend (`llmJudge`). */
  judge?: Judge;
  /** JSONL journal; omit to journal nothing. */
  journalPath?: string;
  /** Replay cached successes from the journal at `journalPath`. */
  resume?: boolean;
  /** Aborts at the next model-call boundary and in-flight requests; the run rejects with AbortError. */
  signal?: AbortSignal;
  /** Hard cap on model calls, agents and judgments together (default 1000). */
  maxAgents?: number;
  /** In-flight model-call cap (default from CPU parallelism). */
  concurrency?: number;
  /** Passed through to the script verbatim as `w.args`. */
  args?: Args;
}

function defaultConcurrency(): number {
  return Math.max(1, Math.min(16, availableParallelism() - 2));
}

/**
 * Run a script. Given a path, the module's default export is the script and the result is
 * `unknown`; given the function itself (handy in tests), the result is whatever it returns.
 */
export function run(script: string, options: RunOptions): Promise<unknown>;
export function run<Args, Result>(
  script: Script<Args, Result>,
  options: RunOptions<Args>,
): Promise<Result>;
export async function run(
  script: string | Script<unknown, unknown>,
  options: RunOptions,
): Promise<unknown> {
  const { backend, judge } = options ?? {};
  if (typeof backend !== "function") {
    throw new TypeError("run(script, {backend}): backend is required and must be a function");
  }
  if (judge !== undefined && typeof judge !== "function") {
    throw new TypeError("run(script, {judge}): judge must be a function when given");
  }
  const journal = new Journal(options.journalPath ?? null, { resume: options.resume ?? false });
  const api = makeApi({
    backend,
    judge: judge ?? llmJudge(backend),
    journal,
    signal: options.signal,
    maxAgents: options.maxAgents ?? 1000,
    concurrency: options.concurrency ?? defaultConcurrency(),
    args: options.args,
  });
  let entry: unknown = script;
  if (typeof script === "string") {
    const module: { default?: unknown } = await import(pathToFileURL(resolve(script)).href);
    entry = module.default;
  }
  if (typeof entry !== "function") {
    throw new TypeError("a heddle script must `export default async function (w) { ... }`");
  }
  const restore = installDeterminismGuards();
  try {
    return await (entry as Script)(api);
  } finally {
    restore();
  }
}
