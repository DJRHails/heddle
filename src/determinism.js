/**
 * Determinism guards: while a script runs, the ambient sources of nondeterminism throw.
 *
 * This is not a sandbox — the script is trusted code running in-process. The guards exist for
 * one reason only: journal replay is sound only if the script's control flow is a pure function
 * of its inputs and its agent results. Math.random() and clock reads are the two ways a script
 * silently stops being that. `new Date(x)` with an explicit argument still works; timestamps
 * belong in `args` or get stamped after run() returns.
 *
 * The guards are process-global while installed (the runner process exists to run one script),
 * and backends capture the real clock before installation via `realClock`.
 */

const RealDate = globalThis.Date;
const realMathRandom = Math.random;
const realNow = RealDate.now.bind(RealDate);

/** The unpatched clock, for runtime bookkeeping (journal timings) while guards are installed. */
export const realClock = { now: realNow };

function deterministicViolation(what, fix) {
  return new Error(
    `${what} is nondeterministic and would make journal replay unsound — ${fix}`,
  );
}

/**
 * True when the guarded call came from Node platform internals rather than script code.
 *
 * The guards are process-global, and the platform itself needs the clock — undici's fetch
 * calls Date.now() while draining a response body, from the same async context as the script's
 * await chain, so neither a realm-free flag nor AsyncLocalStorage can tell the two apart. The
 * caller's stack frame can: a platform call's nearest non-guard frame is a node:internal
 * module. Documented heuristic, not a boundary — a script calling through a dependency that
 * calls Date.now() would be exempted too, which is acceptable for trusted scripts whose own
 * control flow is what replay soundness depends on.
 */
function calledFromPlatform() {
  const stack = new Error().stack ?? "";
  const frames = stack.split("\n").slice(1); // drop the "Error" line
  for (const frame of frames) {
    if (frame.includes("determinism.js")) continue; // the guard's own frames
    return frame.includes("node:internal");
  }
  return false;
}

/** Install the guards. Returns a restore function; always call it (try/finally). */
export function installDeterminismGuards() {
  Math.random = () => {
    if (calledFromPlatform()) return realMathRandom();
    throw deterministicViolation(
      "Math.random()",
      "vary behaviour by index or by input instead",
    );
  };

  const GuardedDate = new Proxy(RealDate, {
    construct(target, argumentsList, newTarget) {
      if (argumentsList.length === 0) {
        if (calledFromPlatform()) return Reflect.construct(target, [realNow()], newTarget);
        throw deterministicViolation(
          "argless new Date()",
          "pass timestamps in via args, e.g. new Date(args.startedAt)",
        );
      }
      return Reflect.construct(target, argumentsList, newTarget);
    },
    apply() {
      throw deterministicViolation("bare Date()", "pass timestamps in via args");
    },
    get(target, property, receiver) {
      if (property === "now") {
        return () => {
          if (calledFromPlatform()) return realNow();
          throw deterministicViolation("Date.now()", "pass timestamps in via args");
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  globalThis.Date = GuardedDate;

  return function restore() {
    Math.random = realMathRandom;
    globalThis.Date = RealDate;
  };
}
