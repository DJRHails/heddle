import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { run } from "../src/index.js";

/** A backend that resolves each prompt via a controllable deferred, recording every call. */
function deferredBackend() {
  const pending = new Map(); // prompt -> resolve fn
  const calls = [];
  const backend = ({ prompt }) => {
    calls.push(prompt);
    return new Promise((resolvePrompt) => pending.set(prompt, resolvePrompt));
  };
  const settle = (prompt, value) => {
    const resolvePrompt = pending.get(prompt);
    if (!resolvePrompt) throw new Error(`nothing pending for ${prompt}`);
    pending.delete(prompt);
    resolvePrompt(value);
  };
  return { backend, settle, calls, pending };
}

/** A backend that echoes instantly, recording calls; prompts in `fail` reject. */
function echoBackend(fail = new Set()) {
  const calls = [];
  const backend = async ({ prompt }) => {
    calls.push(prompt);
    if (fail.has(prompt)) throw new Error(`scripted failure for ${prompt}`);
    return `echo:${prompt}`;
  };
  return { backend, calls };
}

describe("pipeline", () => {
  it("interleaves: item A reaches stage 3 before item B finishes stage 1", async () => {
    const { backend, settle, pending } = deferredBackend();
    const order = [];
    const script = async (w) =>
      w.pipeline(
        ["A", "B"],
        (item) => {
          order.push(`s1:${item}`);
          return w.agent(`s1:${item}`);
        },
        (previous, item) => {
          order.push(`s2:${item}`);
          return w.agent(`s2:${item}`);
        },
        (previous, item) => {
          order.push(`s3:${item}`);
          return `${item}-done`;
        },
      );
    const running = run(script, { backend, concurrency: 8 });
    // Let both stage-1 calls dispatch, then advance only A through both agent stages while B's
    // stage-1 call stays pending. If stage 3 of A runs, the pipeline has no cross-stage barrier.
    await new Promise((tick) => setTimeout(tick, 10));
    settle("s1:A", "a1");
    await new Promise((tick) => setTimeout(tick, 10));
    settle("s2:A", "a2");
    await new Promise((tick) => setTimeout(tick, 10));
    expect(order).toContain("s3:A");
    expect(pending.has("s1:B")).toBe(true); // B is still mid-stage-1 while A finished stage 3
    settle("s1:B", "b1");
    await new Promise((tick) => setTimeout(tick, 10));
    settle("s2:B", "b2");
    await expect(running).resolves.toEqual(["A-done", "B-done"]);
  });

  it("a throwing stage drops that item to null without touching its neighbours", async () => {
    const { backend } = echoBackend();
    const script = async (w) =>
      w.pipeline(
        [1, 2, 3],
        (item) => {
          if (item === 2) throw new Error("boom");
          return w.agent(`ok:${item}`);
        },
        (previous) => `${previous}!`,
      );
    await expect(run(script, { backend })).resolves.toEqual(["echo:ok:1!", null, "echo:ok:3!"]);
  });
});

describe("parallel", () => {
  it("rejects promises with a loud TypeError naming the mistake", async () => {
    const { backend } = echoBackend();
    const script = async (w) => w.parallel([Promise.resolve(1)]);
    await expect(run(script, { backend })).rejects.toThrow(/thunks .* not promises/);
  });

  it("a failing thunk becomes null; the call itself never rejects", async () => {
    const { backend } = echoBackend(new Set(["dies"]));
    const script = async (w) =>
      w.parallel([() => w.agent("lives"), () => w.agent("dies"), () => w.agent("also-lives")]);
    // agent() resolves null on terminal backend failure, so the fan-out survives.
    await expect(run(script, { backend })).resolves.toEqual([
      "echo:lives",
      null,
      "echo:also-lives",
    ]);
  });

  it("a thunk that throws synchronously is null too", async () => {
    const { backend } = echoBackend();
    const script = async (w) =>
      w.parallel([
        () => {
          throw new Error("sync boom");
        },
        () => w.agent("fine"),
      ]);
    await expect(run(script, { backend })).resolves.toEqual([null, "echo:fine"]);
  });
});

describe("determinism guards", () => {
  it("Math.random, Date.now, bare Date() and argless new Date() throw; new Date(x) works", async () => {
    const { backend } = echoBackend();
    const outcomes = await run(
      async () => {
        const attempt = (fn) => {
          try {
            fn();
            return "allowed";
          } catch (error) {
            return `threw: ${error.message.slice(0, 40)}`;
          }
        };
        return {
          random: attempt(() => Math.random()),
          now: attempt(() => Date.now()),
          bare: attempt(() => Date()),
          argless: attempt(() => new Date()),
          withArg: attempt(() => new Date(0)),
        };
      },
      { backend },
    );
    expect(outcomes.random).toMatch(/^threw/);
    expect(outcomes.now).toMatch(/^threw/);
    expect(outcomes.bare).toMatch(/^threw/);
    expect(outcomes.argless).toMatch(/^threw/);
    expect(outcomes.withArg).toBe("allowed");
    expect(Date.now()).toBeGreaterThan(0); // restored after the run
  });
});

describe("journal and resume", () => {
  const scriptSource = (editedLateStage) => async (w) => {
    const early = await w.parallel([() => w.agent("early:1"), () => w.agent("early:2")]);
    const late = await w.agent(editedLateStage ? "late:EDITED" : "late:original");
    return { early, late };
  };

  it("replays the unchanged calls and re-runs only from the first edited one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heddle-"));
    const journalPath = join(dir, "journal.jsonl");
    const first = echoBackend();
    const initial = await run(scriptSource(false), { backend: first.backend, journalPath });
    expect(initial.late).toBe("echo:late:original");
    expect(first.calls).toHaveLength(3);

    const second = echoBackend();
    const resumed = await run(scriptSource(true), {
      backend: second.backend,
      journalPath,
      resume: true,
    });
    // The two early calls replay from the journal; only the edited late call hits the backend.
    expect(second.calls).toEqual(["late:EDITED"]);
    expect(resumed.early).toEqual(["echo:early:1", "echo:early:2"]);
    expect(resumed.late).toBe("echo:late:EDITED");
    const lines = readFileSync(journalPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(4); // 3 from the first run + 1 new
  });

  it("failed calls are journaled but never replayed as results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heddle-"));
    const journalPath = join(dir, "journal.jsonl");
    const failing = echoBackend(new Set(["flaky"]));
    const script = async (w) => w.agent("flaky");
    expect(await run(script, { backend: failing.backend, journalPath })).toBeNull();

    const healed = echoBackend(); // same call succeeds now
    const result = await run(script, { backend: healed.backend, journalPath, resume: true });
    expect(healed.calls).toEqual(["flaky"]); // it re-ran instead of replaying the failure
    expect(result).toBe("echo:flaky");
  });

  it("byte-identical repeated calls replay per occurrence, in issuance order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heddle-"));
    const journalPath = join(dir, "journal.jsonl");
    let n = 0;
    const counting = async () => {
      n += 1;
      return `call-${n}`;
    };
    const script = async (w) => [await w.agent("same"), await w.agent("same")];
    const first = await run(script, { backend: counting, journalPath });
    expect(first).toEqual(["call-1", "call-2"]);
    const resumed = await run(script, { backend: counting, journalPath, resume: true });
    expect(resumed).toEqual(["call-1", "call-2"]); // both occurrences replayed, none re-run
    expect(n).toBe(2);
  });
});

describe("caps and abort", () => {
  it("the total-agent cap stops a runaway loop", async () => {
    const { backend } = echoBackend();
    const script = async (w) => {
      for (let i = 0; i < 100; i += 1) await w.agent(`call ${i}`);
    };
    await expect(run(script, { backend, maxAgents: 5 })).rejects.toThrow(/cap reached/);
  });

  it("abort unwinds the run instead of reading as null findings", async () => {
    const { backend, settle } = deferredBackend();
    const controller = new AbortController();
    const script = async (w) =>
      w.parallel([() => w.agent("slow"), () => w.agent("also slow")]);
    const running = run(script, { backend, signal: controller.signal });
    await new Promise((tick) => setTimeout(tick, 10));
    controller.abort();
    settle("slow", "too late");
    settle("also slow", "too late");
    await expect(running).rejects.toThrow(/aborted/);
  });

  it("concurrency is respected", async () => {
    let inFlight = 0;
    let peak = 0;
    const backend = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((tick) => setTimeout(tick, 5));
      inFlight -= 1;
      return "ok";
    };
    const script = async (w) =>
      w.parallel(Array.from({ length: 10 }, (_, i) => () => w.agent(`c${i}`)));
    await run(script, { backend, concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
  });
});
