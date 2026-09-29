import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  run,
  type Answer,
  type Backend,
  type Judge,
  type JournalEntry,
  type Question,
  type Workflow,
} from "../src/index.ts";

const echoBackend: Backend = async ({ prompt }) => `echo:${prompt}`;

/**
 * A scripted judge: `answer(state, question)` returns the answer for the single question each
 * primitive asks; every request is recorded. Mirrors Jev's response shape.
 */
function scriptedJudge(answer: (state: unknown, question: Question) => Answer) {
  const requests: Array<{ state: unknown; question: Question }> = [];
  const judge: Judge = async ({ state, questions }) => {
    const question = questions.q;
    if (!question) throw new Error("the primitives ask exactly one question, under id q");
    requests.push({ state, question });
    return { model: "scripted", answers: { q: answer(state, question) } };
  };
  judge.model = "scripted";
  return { judge, requests };
}

/** A judge whose noul answer is looked up by state (p(yes)); choice by a fixed distribution. */
function yesProbabilityJudge(
  pYesByState: Record<string, number>,
  choiceProbabilities: Record<string, number> = {},
) {
  return scriptedJudge((state, question) => {
    if (question.type === "noul") {
      const noul = pYesByState[String(state)];
      if (noul === undefined) throw new Error(`no scripted p(yes) for state ${String(state)}`);
      return { type: "noul", noul };
    }
    const ranked = Object.entries(choiceProbabilities).sort((a, b) => b[1] - a[1]);
    const choice = ranked[0]?.[0] ?? "";
    return { type: "choice", choice, probabilities: choiceProbabilities, confidence: 0.5 };
  });
}

describe("feels", () => {
  it("is true, false, or null (unsure) against a confidence threshold", async () => {
    const { judge } = yesProbabilityJudge({ clear: 0.9, no: 0.1, split: 0.6 });
    const script = async (w: Workflow) => ({
      clear: await w.feels("clear", "urgent", { confidence: 0.8 }),
      no: await w.feels("no", "urgent", { confidence: 0.8 }),
      split: await w.feels("split", "urgent", { confidence: 0.8 }),
      splitDefault: await w.feels("split", "urgent"),
    });
    await expect(run(script, { backend: echoBackend, judge })).resolves.toEqual({
      clear: true,
      no: false,
      split: null,
      splitDefault: true, // at the default 0.5 threshold, null never occurs
    });
  });

  it("a tie is yes, and the state is sent as data with a noul question", async () => {
    const { judge, requests } = yesProbabilityJudge({ "meh.": 0.5 });
    const script = async (w: Workflow) => w.feels("meh.", "genuinely urgent");
    await expect(run(script, { backend: echoBackend, judge })).resolves.toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.state).toBe("meh.");
    expect(requests[0]?.question.type).toBe("noul");
    expect(requests[0]?.question.instructions).toContain("genuinely urgent");
  });

  it("an unobtainable judgment throws rather than resolving null", async () => {
    const judge: Judge = async () => {
      throw new Error("jev 529: overloaded");
    };
    const script = async (w: Workflow) => w.feels("x", "urgent");
    await expect(run(script, { backend: echoBackend, judge })).rejects.toThrow(/529/);
  });
});

describe("match", () => {
  const probabilities = { "a bug report": 0.2, "a feature request": 0.7, "something else": 0.1 };

  it("returns the winning label from an array of labels", async () => {
    const { judge, requests } = yesProbabilityJudge({}, probabilities);
    const script = async (w: Workflow) =>
      w.match("please add dark mode", Object.keys(probabilities));
    await expect(run(script, { backend: echoBackend, judge })).resolves.toBe("a feature request");
    expect(requests[0]?.question).toMatchObject({
      type: "choice",
      criteria: { "a bug report": null, "a feature request": null, "something else": null },
    });
  });

  it("accepts {label: description} criteria and gates on confidence", async () => {
    const { judge, requests } = yesProbabilityJudge({}, probabilities);
    const script = async (w: Workflow) => ({
      ungated: await w.match("x", {
        "a bug report": "broken",
        "a feature request": "wanted",
        "something else": null,
      }),
      gated: await w.match("x", Object.keys(probabilities), { confidence: 0.8 }),
    });
    await expect(run(script, { backend: echoBackend, judge })).resolves.toEqual({
      ungated: "a feature request",
      gated: null,
    });
    expect(requests[0]?.question).toMatchObject({ criteria: { "a bug report": "broken" } });
  });

  it("refuses fewer than two labels", async () => {
    const { judge } = yesProbabilityJudge({}, probabilities);
    const script = async (w: Workflow) => w.match("x", ["only one"]);
    await expect(run(script, { backend: echoBackend, judge })).rejects.toThrow(/at least 2/);
  });
});

describe("judgments in the scheduler", () => {
  it("are journaled with kind 'judge' and replayed on resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heddle-"));
    const journalPath = join(dir, "journal.jsonl");
    const script = async (w: Workflow) => [await w.feels("mail", "urgent"), await w.agent("draft")];

    const first = yesProbabilityJudge({ mail: 0.9 });
    await expect(
      run(script, { backend: echoBackend, judge: first.judge, journalPath }),
    ).resolves.toEqual([true, "echo:draft"]);
    expect(first.requests).toHaveLength(1);

    const second = yesProbabilityJudge({ mail: 0.1 }); // would now say no — but it must not be asked
    const resumed = await run(script, {
      backend: echoBackend,
      judge: second.judge,
      journalPath,
      resume: true,
    });
    expect(second.requests).toHaveLength(0);
    expect(resumed).toEqual([true, "echo:draft"]);

    const entries = readFileSync(journalPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as JournalEntry);
    expect(entries.map((e) => e.kind)).toEqual(["judge", "agent"]);
    expect(entries[0]).toMatchObject({
      state: "mail",
      model: "scripted",
      status: "ok",
      result: { answers: { q: { noul: 0.9 } } },
    });
  });

  it("a different judge model re-judges instead of replaying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heddle-"));
    const journalPath = join(dir, "journal.jsonl");
    const script = async (w: Workflow) => w.feels("mail", "urgent");
    const first = yesProbabilityJudge({ mail: 0.9 });
    await run(script, { backend: echoBackend, judge: first.judge, journalPath });
    const other = yesProbabilityJudge({ mail: 0.1 });
    other.judge.model = "other-model";
    const resumed = await run(script, {
      backend: echoBackend,
      judge: other.judge,
      journalPath,
      resume: true,
    });
    expect(other.requests).toHaveLength(1);
    expect(resumed).toBe(false);
  });

  it("count toward the model-call cap", async () => {
    const { judge } = scriptedJudge(() => ({ type: "noul", noul: 0.9 }));
    const script = async (w: Workflow) => {
      for (let i = 0; i < 10; i += 1) await w.feels(`m${i}`, "urgent");
    };
    await expect(run(script, { backend: echoBackend, judge, maxAgents: 4 })).rejects.toThrow(
      /cap reached/,
    );
  });

  it("without a judge, the backend emulates one through structured output", async () => {
    const seen: Array<{ prompt: string; schema: unknown }> = [];
    const backend: Backend = async ({ prompt, schema }) => {
      seen.push({ prompt, schema });
      return { q: { yes: 0.85 } };
    };
    const script = async (w: Workflow) => w.feels("the server is on fire", "urgent");
    await expect(run(script, { backend })).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.schema).toMatchObject({
      properties: { q: { properties: { yes: { type: "number", maximum: 1 } } } },
    });
    expect(seen[0]?.prompt).toContain("the server is on fire");
  });
});
