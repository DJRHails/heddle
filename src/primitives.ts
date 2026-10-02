/**
 * The primitives, bound to one run's scheduler.
 *
 * Generation:
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
 * Memory (see contexts.ts):
 * - context(name, options) -> a context file: a leaf that rewrites its own live context across
 *   sequential steps. Each step is one agent call through the same scheduler, journaled with
 *   the context's name.
 *
 * Judgment (see decisions.ts for feels/match built on it):
 * - judge(state, question) -> Promise<answer>: one typed question about a state, answered with
 *   calibrated probabilities by the run's judge (Jev, or a text model emulating Jev's contract
 *   through structured output). Unlike agent(), a judgment that cannot be obtained THROWS: null
 *   is reserved for "the model is unsure", which is a real outcome a script routes on, so an
 *   infrastructure failure must not be spelled the same way.
 *
 * Every model call — agent or judge — shares one scheduler: the journal (replay), the total
 * call cap (runaway-loop backstop), the concurrency ceiling, and the abort race. Abort is the
 * one error that propagates through everything: an aborted run must unwind, never read as a
 * null finding.
 */

import { makeContexts } from "./contexts.ts";
import { makeDecisions } from "./decisions.ts";
import { realClock } from "./determinism.ts";
import { callKey, judgeKey, type Journal, type JournalRecord } from "./journal.ts";
import type {
  AgentOptions,
  AnswerFor,
  Backend,
  Judge,
  Question,
  Stage,
  Thunk,
  Workflow,
} from "./types.ts";

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("run aborted");
  error.name = "AbortError";
  return error;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SchedulerOptions<Args> {
  backend: Backend;
  judge: Judge;
  journal: Journal;
  signal?: AbortSignal;
  maxAgents: number;
  concurrency: number;
  args: Args;
}

export function makeApi<Args>({
  backend,
  judge,
  journal,
  signal,
  maxAgents,
  concurrency,
  args,
}: SchedulerOptions<Args>): Workflow<Args> {
  let inFlight = 0;
  let launched = 0;
  const waiters: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (inFlight < concurrency) {
      inFlight += 1;
      return Promise.resolve();
    }
    return new Promise((resolveWaiter) => waiters.push(resolveWaiter));
  }

  function release(): void {
    const next = waiters.shift();
    if (next) {
      next(); // the slot transfers; inFlight is unchanged
      return;
    }
    inFlight -= 1;
  }

  /** Race a call against the abort signal so an in-flight call cannot outlive an abort. */
  function raceAbort<T>(call: Promise<T>): Promise<T> {
    if (!signal) return call;
    return Promise.race([
      call,
      new Promise<never>((_, rejectRace) =>
        signal.addEventListener(
          "abort",
          () => {
            call.catch(() => {}); // silence the loser
            rejectRace(abortError());
          },
          { once: true },
        ),
      ),
    ]);
  }

  /**
   * Settle one model call through the shared scheduler: replay from the journal when cached,
   * else enforce the cap, take a slot, run `call`, and journal the outcome. Rethrows failures
   * (journaled as status "error"); callers decide whether that becomes null or propagates.
   * `record` is the journal entry's descriptive part (what was asked, and of whom).
   */
  async function settle(
    key: string,
    record: JournalRecord,
    call: () => Promise<unknown>,
  ): Promise<unknown> {
    const occurrence = journal.nextOccurrence(key);
    const cached = journal.replay(key, occurrence);
    if (cached !== undefined) return cached.result;
    if (signal?.aborted) throw abortError();
    launched += 1;
    if (launched > maxAgents) {
      const error = new Error(
        `model-call cap reached (${maxAgents}) — a runaway loop backstop; raise maxAgents if` +
          " the fan-out is intentional",
      );
      error.name = "CapError";
      throw error;
    }
    await acquire();
    const started = realClock.now();
    try {
      if (signal?.aborted) throw abortError();
      const result = await raceAbort(call());
      journal.append({
        key,
        occurrence,
        ...record,
        status: "ok",
        result,
        ms: realClock.now() - started,
      });
      return result;
    } catch (error) {
      if (!isAbortError(error)) {
        journal.append({
          key,
          occurrence,
          ...record,
          status: "error",
          error: errorMessage(error),
          ms: realClock.now() - started,
        });
      }
      throw error;
    } finally {
      release();
    }
  }

  function agent(prompt: string, opts: AgentOptions = {}): Promise<unknown> {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new TypeError("agent(prompt, opts): prompt must be a non-empty string");
    }
    return agentCall(prompt, opts, undefined);
  }

  /** One agent call, journaled with the context file it belongs to when it is a step. */
  async function agentCall(
    prompt: string,
    opts: AgentOptions,
    context: string | undefined,
  ): Promise<unknown> {
    const record: JournalRecord = {
      kind: "agent",
      prompt,
      opts: { ...opts },
      ...(context === undefined ? {} : { context }),
    };
    try {
      return await settle(callKey(prompt, opts), record, () =>
        backend({ ...opts, prompt, signal }),
      );
    } catch (error) {
      if (isAbortError(error) || errorName(error) === "CapError") throw error;
      return null; // terminal failure: the caller filters; the journal has the story
    }
  }

  async function judgeOne<Q extends Question>(state: unknown, question: Q): Promise<AnswerFor<Q>> {
    if (state === undefined) {
      throw new TypeError("judge(state, question): state is required (a string or JSON value)");
    }
    if (!question || typeof question.type !== "string") {
      throw new TypeError(
        'judge(state, question): question must be {type: "noul" | "choice" | "score", ...}',
      );
    }
    const record: JournalRecord = { kind: "judge", state, question, model: judge.model ?? null };
    const key = judgeKey(state, question, judge.model);
    const response = (await settle(key, record, () =>
      judge({ state, questions: { q: question }, signal }),
    )) as { answers?: Record<string, { type?: string }> } | null | undefined;
    const answer = response?.answers?.q;
    if (!answer || answer.type !== question.type) {
      throw new Error(
        `judge returned no ${question.type} answer — got ${JSON.stringify(response).slice(0, 200)}`,
      );
    }
    return answer as AnswerFor<Q>;
  }

  async function parallel<T>(thunks: ReadonlyArray<Thunk<T>>): Promise<Array<Awaited<T> | null>> {
    if (!Array.isArray(thunks)) {
      throw new TypeError("parallel(thunks): expected an array of () => Promise");
    }
    for (const [index, thunk] of thunks.entries()) {
      if (typeof thunk === "function") continue;
      const promiseLike = thunk as { then?: unknown } | null;
      const hint =
        promiseLike && typeof promiseLike.then === "function"
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

  async function pipeline<A>(
    items: readonly A[],
    ...stages: Array<Stage<unknown, A, unknown>>
  ): Promise<unknown[]> {
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
        let value: unknown = item;
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

  return {
    // The Workflow overloads say what the backend returns for each call shape (text without a
    // schema, the schema's payload with one, per-stage types through a pipeline); the
    // implementations only know `unknown`, so they are asserted into the declared shapes here.
    agent: agent as Workflow<Args>["agent"],
    parallel,
    pipeline: pipeline as Workflow<Args>["pipeline"],
    judge: judgeOne,
    ...makeDecisions(judgeOne),
    context: makeContexts(agentCall),
    args,
  };
}
