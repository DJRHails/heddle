/**
 * The runner: execute a script file (or function) and return its return value.
 *
 * A script is an ordinary ES module exporting `default async function (w) { ... }`; it receives
 * the api object `{ agent, parallel, pipeline, args }` and whatever it returns is run()'s
 * result. There is no sandbox: the script is trusted code running in-process with real stack
 * traces and a debugger that works (see README — node:vm is not a security boundary, so it
 * bought nothing but bare-realm footguns). Determinism guards are installed for the duration:
 * Math.random(), Date.now(), bare Date() and argless new Date() throw; new Date(x) works.
 */

import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { installDeterminismGuards } from "./determinism.js";
import { Journal } from "./journal.js";
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
 * @param {string} [options.journalPath]  JSONL journal; omit to journal nothing.
 * @param {boolean} [options.resume]  replay cached successes from the journal at journalPath.
 * @param {AbortSignal} [options.signal]  aborts at the next agent-call boundary and in-flight
 *   backend requests; the run rejects with AbortError.
 * @param {number} [options.maxAgents]  hard total-agent cap (default 1000).
 * @param {number} [options.concurrency]  in-flight agent cap (default from CPU parallelism).
 * @param {*} [options.args]  passed through to the script verbatim as w.args.
 */
export async function run(script, options) {
  const { backend } = options ?? {};
  if (typeof backend !== "function") {
    throw new TypeError("run(script, {backend}): backend is required and must be a function");
  }
  const journal = new Journal(options.journalPath ?? null, { resume: options.resume ?? false });
  const api = makeApi({
    backend,
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
