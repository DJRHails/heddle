import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { anthropicBackend } from "../src/backends/anthropic.ts";
import { llmJudge } from "../src/judges/llm.ts";
import { run, type Backend, type CallReport, type Usage, type Workflow } from "../src/index.ts";

const USAGE: Usage = { model: "stub-model", inputTokens: 100, outputTokens: 7 };

/** A backend that meters one fixed usage per call and echoes the prompt. */
const meteredBackend: Backend = async ({ prompt, meter }) => {
  meter?.(USAGE);
  return `echo:${prompt}`;
};

describe("usage metering", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("journals each call's usage and reports it live, then replayed from the journal", async () => {
    const journalPath = join(mkdtempSync(join(tmpdir(), "heddle-meter-")), "run.jsonl");
    const script = async (w: Workflow) => w.agent("hello");

    const live: CallReport[] = [];
    await run(script, { backend: meteredBackend, journalPath, onCall: (c) => live.push(c) });
    expect(live).toEqual([{ kind: "agent", status: "ok", replayed: false, usage: [USAGE] }]);
    const entry = JSON.parse(readFileSync(journalPath, "utf8").trim()) as { usage: Usage[] };
    expect(entry.usage).toEqual([USAGE]);

    const replayed: CallReport[] = [];
    const never: Backend = async () => {
      throw new Error("a replayed call must not reach the backend");
    };
    await run(script, {
      backend: never,
      journalPath,
      resume: true,
      onCall: (c) => replayed.push(c),
    });
    expect(replayed).toEqual([{ kind: "agent", status: "ok", replayed: true, usage: [USAGE] }]);
  });

  it("reports a failed call's usage as an error, and meters judgments through llmJudge", async () => {
    const failing: Backend = async ({ meter, schema }) => {
      meter?.(USAGE);
      if (!schema) throw new Error("scripted failure");
      return { q: { yes: 0.9 } };
    };
    const reports: CallReport[] = [];
    const script = async (w: Workflow) => [await w.agent("doomed"), await w.feels("s", "x")];
    const result = await run(script, {
      backend: failing,
      judge: llmJudge(failing),
      onCall: (c) => reports.push(c),
    });
    expect(result).toEqual([null, true]);
    expect(reports).toEqual([
      { kind: "agent", status: "error", replayed: false, usage: [USAGE] },
      { kind: "judge", status: "ok", replayed: false, usage: [USAGE] },
    ]);
  });

  it("anthropicBackend meters every Messages request, schema retries included", async () => {
    const reply = (input: unknown) =>
      new Response(
        JSON.stringify({
          content: [{ type: "tool_use", id: "t", name: "structured_output", input }],
          usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 10 },
        }),
        { status: 200 },
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply({ wrong: true }))
      .mockResolvedValueOnce(reply({ score: 3 }));
    vi.stubGlobal("fetch", fetchMock);

    const seen: Usage[] = [];
    const backend = anthropicBackend({ apiKey: "k", defaultModel: "claude-haiku-4-5" });
    const schema = {
      type: "object",
      properties: { score: { type: "number" } },
      required: ["score"],
      additionalProperties: false,
    };
    const payload = await backend({ prompt: "p", schema, meter: (u) => seen.push(u) });
    expect(payload).toEqual({ score: 3 });
    const one = {
      model: "claude-haiku-4-5",
      inputTokens: 50,
      outputTokens: 5,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
    };
    expect(seen).toEqual([one, one]);
  });
});
