/**
 * The three primitives, bound to one run's scheduler.
 *
 * - agent(prompt, opts) -> Promise<any>: one subagent call. Resolves the backend's result
 *   (structured object when opts.schema is set, final text otherwise), or null on terminal
 *   failure after the backend's bounded retries — a dead agent never kills a fan-out. Cached
 *   calls (same prompt + semantic opts, same occurrence) replay from the journal.
 * - parallel(thunks) -> Promise<array>: a barrier. Takes thunks, not promises — a promise is
 *   already running and cannot be throttled, so passing one is a loud TypeError. A thunk that
 *   throws resolves to null in the result array; the call itself never rejects (except abort).
 * - pipeline(items, ...stages) -> Promise<array>: NOT a barrier. Each item flows through all
 *   stages independently; item A can be in stage 3 while item B is in stage 1, so wall-clock is
 *   the slowest single chain. A stage that throws drops that item to null and skips its
 *   remaining stages. Stage callbacks receive (previous, originalItem, index).
 *
 * Abort is the one error that propagates through everything: an aborted run must unwind, never
 * read as a null finding.
 */

import { realClock } from "./determinism.js";
import { callKey } from "./journal.js";

export function isAbortError(error) {
  return error instanceof Error && error.name === "AbortError";
}

function abortError() {
  const error = new Error("run aborted");
  error.name = "AbortError";
  return error;
}

export function makeApi({ backend, journal, signal, maxAgents, concurrency, args }) {
  let inFlight = 0;
  let launched = 0;
  const waiters = [];

  function acquire() {
    if (inFlight < concurrency) {
      inFlight += 1;
      return Promise.resolve();
    }
    return new Promise((resolveWaiter) => waiters.push(resolveWaiter));
  }

  function release() {
    const next = waiters.shift();
    if (next) {
      next(); // the slot transfers; inFlight is unchanged
      return;
    }
    inFlight -= 1;
  }

  async function agent(prompt, opts = {}) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new TypeError("agent(prompt, opts): prompt must be a non-empty string");
    }
    const key = callKey(prompt, opts);
    const occurrence = journal.nextOccurrence(key);
    const cached = journal.replay(key, occurrence);
    if (cached !== undefined) return cached.result;
    if (signal?.aborted) throw abortError();
    launched += 1;
    if (launched > maxAgents) {
      throw new Error(
        `agent cap reached (${maxAgents}) — a runaway loop backstop; raise maxAgents if the` +
          " fan-out is intentional",
      );
    }
    await acquire();
    const started = realClock.now();
    const publicOpts = { ...opts };
    try {
      if (signal?.aborted) throw abortError();
      const call = backend({ ...opts, prompt, signal });
      // Race the signal so an in-flight call cannot outlive an abort even when the backend
      // ignores it; the losing promise is silenced to avoid an unhandled rejection.
      const result = signal
        ? await Promise.race([
            call,
            new Promise((_, rejectRace) =>
              signal.addEventListener(
                "abort",
                () => {
                  Promise.resolve(call).catch(() => {});
                  rejectRace(abortError());
                },
                { once: true },
              ),
            ),
          ])
        : await call;
      journal.append({
        key,
        occurrence,
        prompt,
        opts: publicOpts,
        status: "ok",
        result,
        ms: realClock.now() - started,
      });
      return result;
    } catch (error) {
      if (isAbortError(error)) throw error;
      journal.append({
        key,
        occurrence,
        prompt,
        opts: publicOpts,
        status: "error",
        error: String(error?.message ?? error),
        ms: realClock.now() - started,
      });
      return null; // terminal failure: the caller filters; the journal has the story
    } finally {
      release();
    }
  }

  async function parallel(thunks) {
    if (!Array.isArray(thunks)) {
      throw new TypeError("parallel(thunks): expected an array of () => Promise");
    }
    for (const [index, thunk] of thunks.entries()) {
      if (typeof thunk === "function") continue;
      const hint =
        thunk && typeof thunk.then === "function"
          ? "item is a promise — already running and unthrottleable; wrap it: () => yourCall()"
          : `item is ${typeof thunk}`;
      throw new TypeError(
        `parallel takes thunks (() => Promise), not promises: ${hint} at index ${index}`,
      );
    }
    return Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await thunk();
        } catch (error) {
          if (isAbortError(error)) throw error;
          return null;
        }
      }),
    );
  }

  async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) {
      throw new TypeError("pipeline(items, ...stages): expected an array of items");
    }
    for (const stage of stages) {
      if (typeof stage !== "function") {
        throw new TypeError("pipeline stages must be functions (previous, item, index) => value");
      }
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value = item;
        for (const stage of stages) {
          try {
            value = await stage(value, item, index);
          } catch (error) {
            if (isAbortError(error)) throw error;
            return null; // this item is dropped; other items' chains are untouched
          }
        }
        return value;
      }),
    );
  }

  return { agent, parallel, pipeline, args };
}
