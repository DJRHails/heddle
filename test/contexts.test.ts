import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { run, type Backend, type BackendRequest, type Workflow } from "../src/index.ts";

/** A backend that answers each step from a script of {reply, context?} payloads. */
function scriptedBackend(payloads: unknown[]) {
  const requests: BackendRequest[] = [];
  const backend: Backend = async (request) => {
    requests.push(request);
    const next = payloads.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { backend, requests };
}

describe("context files", () => {
  it("appends a step's observation and reply as turns when the model does not rewrite", async () => {
    const { backend, requests } = scriptedBackend([{ reply: "noted" }, { reply: "two" }]);
    const script = async (w: Workflow) => {
      const file = w.context("reader", { task: "Track the failing tests.", system: "be terse" });
      await file.step("chunk one");
      await file.step("chunk two");
      return { text: file.text, steps: file.steps };
    };
    const result = await run(script, { backend });
    expect(result).toEqual({
      text:
        "[[CTX_TURN 1 role=user]]\nchunk one\n[[CTX_TURN 2 role=assistant]]\nnoted\n" +
        "[[CTX_TURN 3 role=user]]\nchunk two\n[[CTX_TURN 4 role=assistant]]\ntwo",
      steps: 2,
    });
    // The pinned contract rides every step outside the file; the file itself is re-sent.
    expect(requests[1]?.system).toBe("be terse");
    expect(requests[1]?.prompt).toContain("<task>\nTrack the failing tests.\n</task>");
    expect(requests[1]?.prompt).toContain(
      '<context_file name="reader">\n[[CTX_TURN 1 role=user]]\nchunk one',
    );
    expect(requests[1]?.prompt).toContain("<observation>\nchunk two\n</observation>");
  });

  it("a rewrite replaces the whole file, and later turns append to the rewrite", async () => {
    const { backend } = scriptedBackend([
      { reply: "a" },
      { reply: "b", context: "NOTES: test_parse fails on quoted commas" },
      { reply: "c" },
    ]);
    const script = async (w: Workflow) => {
      const file = w.context("reader", { task: "t" });
      await file.step("one");
      await file.step("two");
      await file.step("three");
      return file.text;
    };
    await expect(run(script, { backend })).resolves.toBe(
      "NOTES: test_parse fails on quoted commas\n" +
        "[[CTX_TURN 3 role=user]]\nthree\n[[CTX_TURN 4 role=assistant]]\nc",
    );
  });

  it("forces the step through a {reply, context?} schema wrapping the caller's", async () => {
    const VERDICT = { type: "object", properties: { score: { type: "number" } } };
    const { backend, requests } = scriptedBackend([{ reply: { score: 90 } }]);
    const script = async (w: Workflow) =>
      w.context("judge", { task: "t" }).step<{ score: number }>("obs", { schema: VERDICT });
    await expect(run(script, { backend })).resolves.toEqual({ score: 90 });
    const schema = requests[0]?.schema as {
      properties: { reply: unknown; context: unknown };
      required: string[];
    };
    expect(schema.properties.reply).toEqual(VERDICT);
    expect(schema.required).toEqual(["reply"]);
  });

  it("shows the size against the budget and flags an over-budget file", async () => {
    const { backend, requests } = scriptedBackend([
      { reply: "x", context: "y".repeat(12) },
      { reply: "z" },
    ]);
    const script = async (w: Workflow) => {
      const file = w.context("reader", { task: "t", budget: 10 });
      await file.step("one");
      await file.step("two");
    };
    await run(script, { backend });
    expect(requests[0]?.prompt).toContain("[context: 0/10 chars]");
    expect(requests[1]?.prompt).toContain(
      "[context: 12/10 chars — OVER budget; compact the file this step]",
    );
  });

  it("a failed step resolves null and leaves the file untouched", async () => {
    const { backend } = scriptedBackend([{ reply: "kept" }, new Error("backend down")]);
    const script = async (w: Workflow) => {
      const file = w.context("reader", { task: "t", initial: "seed" });
      await file.step("one");
      const before = file.text;
      const failed = await file.step("two");
      return { failed, unchanged: file.text === before, steps: file.steps };
    };
    await expect(run(script, { backend })).resolves.toEqual({
      failed: null,
      unchanged: true,
      steps: 1,
    });
  });

  it("refuses a step while the previous one is in flight", async () => {
    const backend: Backend = () => new Promise(() => {});
    const script = async (w: Workflow) => {
      const file = w.context("reader", { task: "t" });
      void file.step("one");
      return file.step("two");
    };
    await expect(run(script, { backend })).rejects.toThrow(/previous step is in flight/);
  });

  it("refuses a duplicate name, an empty task, and a non-positive budget", async () => {
    const { backend } = scriptedBackend([]);
    const duplicate = async (w: Workflow) => {
      w.context("reader", { task: "t" });
      w.context("reader", { task: "t" });
    };
    await expect(run(duplicate, { backend })).rejects.toThrow(/already exists/);
    const noTask = async (w: Workflow) => w.context("reader", { task: " " });
    await expect(run(noTask, { backend })).rejects.toThrow(/task must be a non-empty string/);
    const badBudget = async (w: Workflow) => w.context("reader", { task: "t", budget: 0 });
    await expect(run(badBudget, { backend })).rejects.toThrow(/budget must be a positive/);
  });

  it("a backend that ignores the schema is a loud error, not a silent null", async () => {
    const { backend } = scriptedBackend(["plain text"]);
    const script = async (w: Workflow) => w.context("reader", { task: "t" }).step("one");
    await expect(run(script, { backend })).rejects.toThrow(/returned no \{reply\} object/);
  });

  it("journals each step with its context and replays the whole file history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heddle-ctx-"));
    const journalPath = join(dir, "run.journal.jsonl");
    const script = async (w: Workflow) => {
      const file = w.context("reader", { task: "t" });
      await file.step("one");
      await file.step("two");
      return file.text;
    };
    const first = scriptedBackend([{ reply: "a", context: "compact" }, { reply: "b" }]);
    const live = await run(script, { backend: first.backend, journalPath });
    const lines = readFileSync(journalPath, "utf8").trim().split("\n");
    const entries = lines.map((line) => JSON.parse(line) as { context?: string });
    expect(entries.map((entry) => entry.context)).toEqual(["reader", "reader"]);

    const second = scriptedBackend([]);
    const replayed = await run(script, { backend: second.backend, journalPath, resume: true });
    expect(replayed).toBe(live);
    expect(second.requests).toHaveLength(0);
  });

  it("contexts coexist, and the script can hand one file to another as an observation", async () => {
    const { backend, requests } = scriptedBackend([
      { reply: "w", context: "worker: found 3 failures" },
      { reply: "o" },
    ]);
    const script = async (w: Workflow) => {
      const worker = w.context("worker", { task: "scan" });
      const orchestrator = w.context("orchestrator", { task: "coordinate" });
      await worker.step("logs");
      await orchestrator.step(`worker file:\n${worker.text}`);
      return orchestrator.text;
    };
    await expect(run(script, { backend })).resolves.toContain("worker: found 3 failures");
    expect(requests[1]?.prompt).toContain('<context_file name="orchestrator">');
  });
});
