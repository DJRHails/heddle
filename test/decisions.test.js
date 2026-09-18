import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { run } from "../src/index.js";

const echoBackend = async ({ prompt }) => `echo:${prompt}`;

/**
 * A scripted judge: `answer(state, question)` returns the answer for the single question each
 * primitive asks; every request is recorded. Mirrors Jev's response shape.
 */
function scriptedJudge(answer) {
  const requests = [];
  const judge = async ({ state, questions }) => {
    requests.push({ state, question: questions.q });
    return { model: "scripted", answers: { q: answer(state, questions.q) } };
  };
  judge.model = "scripted";
  return { judge, requests };
}

/** A judge whose noul answer is looked up by state (p(yes)); choice by a fixed distribution. */
function yesProbabilityJudge(pYesByState, choiceProbabilities) {
  return scriptedJudge((state, question) => {
    if (question.type === "noul") return { type: "noul", noul: pYesByState[state] };
    const choice = Object.entries(choiceProbabilities).sort((a, b) => b[1] - a[1])[0][0];
    return { type: "choice", choice, probabilities: choiceProbabilities, confidence: 0.5 };
  });
}

describe("feels", () => {
  it("is true, false, or null (unsure) against a confidence threshold", async () => {
    const { judge } = yesProbabilityJudge({ clear: 0.9, no: 0.1, split: 0.6 });
    const script = async (w) => ({
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
    const script = async (w) => w.feels("meh.", "genuinely urgent");
    await expect(run(script, { backend: echoBackend, judge })).resolves.toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].state).toBe("meh.");
    expect(requests[0].question.type).toBe("noul");
    expect(requests[0].question.instructions).toContain("genuinely urgent");
  });

  it("an unobtainable judgment throws rather than resolving null", async () => {
    const judge = async () => {
      throw new Error("jev 529: overloaded");
    };
    const script = async (w) => w.feels("x", "urgent");
    await expect(run(script, { backend: echoBackend, judge })).rejects.toThrow(/529/);
  });
});

describe("match", () => {
  const probabilities = { "a bug report": 0.2, "a feature request": 0.7, "something else": 0.1 };

  it("returns the winning label from an array of labels", async () => {
    const { judge, requests } = yesProbabilityJudge({}, probabilities);
    const script = async (w) => w.match("please add dark mode", Object.keys(probabilities));
    await expect(run(script, { backend: echoBackend, judge })).resolves.toBe("a feature request");
    expect(requests[0].question).toMatchObject({
      type: "choice",
      criteria: { "a bug report": null, "a feature request": null, "something else": null },
    });
  });

  it("accepts {label: description} criteria and gates on confidence", async () => {
    const { judge, requests } = yesProbabilityJudge({}, probabilities);
    const script = async (w) => ({
      ungated: await w.match("x", { "a bug report": "broken", "a feature request": "wanted", "something else": null }),
      gated: await w.match("x", Object.keys(probabilities), { confidence: 0.8 }),
    });
    await expect(run(script, { backend: echoBackend, judge })).resolves.toEqual({
      ungated: "a feature request",
      gated: null,
    });
    expect(requests[0].question.criteria["a bug report"]).toBe("broken");
  });

  it("refuses fewer than two labels", async () => {
    const { judge } = yesProbabilityJudge({}, probabilities);
    const script = async (w) => w.match("x", ["only one"]);
    await expect(run(script, { backend: echoBackend, judge })).rejects.toThrow(/at least 2/);
  });
});

describe("judgments in the scheduler", () => {
  it("are journaled with kind 'judge' and replayed on resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heddle-"));
    const journalPath = join(dir, "journal.jsonl");
    const script = async (w) => [await w.feels("mail", "urgent"), await w.agent("draft")];

    const first = yesProbabilityJudge({ mail: 0.9 });
    await expect(run(script, { backend: echoBackend, judge: first.judge, journalPath })).resolves.toEqual([true, "echo:draft"]);
    expect(first.requests).toHaveLength(1);

    const second = yesProbabilityJudge({ mail: 0.1 }); // would now say no — but it must not be asked
    const resumed = await run(script, { backend: echoBackend, judge: second.judge, journalPath, resume: true });
    expect(second.requests).toHaveLength(0);
    expect(resumed).toEqual([true, "echo:draft"]);

    const entries = readFileSync(journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.map((e) => e.kind)).toEqual(["judge", "agent"]);
    expect(entries[0]).toMatchObject({ state: "mail", model: "scripted", status: "ok" });
    expect(entries[0].result.answers.q.noul).toBe(0.9);
  });

  it("a different judge model re-judges instead of replaying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heddle-"));
    const journalPath = join(dir, "journal.jsonl");
    const script = async (w) => w.feels("mail", "urgent");
    const first = yesProbabilityJudge({ mail: 0.9 });
    await run(script, { backend: echoBackend, judge: first.judge, journalPath });
    const other = yesProbabilityJudge({ mail: 0.1 });
    other.judge.model = "other-model";
    const resumed = await run(script, { backend: echoBackend, judge: other.judge, journalPath, resume: true });
    expect(other.requests).toHaveLength(1);
    expect(resumed).toBe(false);
  });

  it("count toward the model-call cap", async () => {
    const { judge } = scriptedJudge(() => ({ type: "noul", noul: 0.9 }));
    const script = async (w) => {
      for (let i = 0; i < 10; i += 1) await w.feels(`m${i}`, "urgent");
    };
    await expect(run(script, { backend: echoBackend, judge, maxAgents: 4 })).rejects.toThrow(/cap reached/);
  });

  it("without a judge, the backend emulates one through structured output", async () => {
    const seen = [];
    const backend = async ({ prompt, schema }) => {
      seen.push({ prompt, schema });
      return { q: { yes: 0.85 } };
    };
    const script = async (w) => w.feels("the server is on fire", "urgent");
    await expect(run(script, { backend })).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].schema.properties.q.properties.yes).toMatchObject({ type: "number", maximum: 1 });
    expect(seen[0].prompt).toContain("the server is on fire");
  });
});
