/**
 * The runner: execute a script file (or function) and return its return value.
 *
 * A script is an ordinary ES module exporting `default async function (w) { ... }`; it receives
 * the api object `{ agent, parallel, pipeline, judge, feels, match, args }` and whatever it
 * returns is run()'s result. Two model seams: `backend` writes (agent), `judge` decides
 * (feels/match); when no judge is given, the backend emulates one through structured
 * output. There is no sandbox: the script is trusted code running in-process with real stack
 * traces and a debugger that works (see README — node:vm is not a security boundary, so it
 * bought nothing but bare-realm footguns). Determinism guards are installed for the duration:
 * Math.random(), Date.now(), bare Date() and argless new Date() throw; new Date(x) works.
 */

import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { installDeterminismGuards } from "./determinism.js";
import { Journal } from "./journal.js";
import { llmJudge } from "./judges/llm.js";
import { makeApi } from "./primitives.js";

function defaultConcurrency() {
  return Math.max(1, Math.min(16, availableParallelism() - 2));
}

/**
 * @param {string|Function} script path to an ES module with a default async export, or the
 *   function itself (handy in tests).
 * @param {object} options
 * @param {Function} options.backend  async ({prompt, system, schema, model, maxTokens, signal})
 *   -> structured object (when schema) or string. Required.
 * @param {Function} [options.judge]  async ({state, questions, signal}) -> {answers}, with a
 *   `.model` property; jevJudge for Jev, or omit to emulate one over the backend (llmJudge).
 * @param {string} [options.journalPath]  JSONL journal; omit to journal nothing.
 * @param {boolean} [options.resume]  replay cached successes from the journal at journalPath.
 * @param {AbortSignal} [options.signal]  aborts at the next model-call boundary and in-flight
 *   requests; the run rejects with AbortError.
 * @param {number} [options.maxAgents]  hard cap on model calls, agents and judgments together
 *   (default 1000).
 * @param {number} [options.concurrency]  in-flight model-call cap (default from CPU parallelism).
 * @param {*} [options.args]  passed through to the script verbatim as w.args.
 */
export async function run(script, options) {
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
  let entry = script;
  if (typeof script === "string") {
    const module = await import(pathToFileURL(resolve(script)).href);
    entry = module.default;
  }
  if (typeof entry !== "function") {
    throw new TypeError("a heddle script must `export default async function (w) { ... }`");
  }
  const restore = installDeterminismGuards();
  try {
    return await entry(api);
  } finally {
    restore();
  }
}
