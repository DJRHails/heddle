import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { costBreakdown, run, type CallReport, type Usage, type Workflow } from "../src/index.ts";
import { judge } from "../src/judges/jev.ts";

const report = (usage: Usage[], replayed = false, status: "ok" | "error" = "ok"): CallReport =>
  ({ kind: "agent", usage, replayed, status });

describe("cost breakdown", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("separates receipts, estimates, unknowns, retries, failures and replay history", () => {
    const paid: Usage = { model: "m", provider: "router", stage: "review",
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30,
      cost: { usd: 0.02, source: "provider" } };
    const estimate: Usage = { ...paid, provider: "typesafe", stage: "screen",
      cost: { usd: 0.001, source: "estimate" } };
    const free: Usage = { ...paid, cost: { usd: 0, source: "provider" } };
    const unpriced: Usage = { model: "unknown", inputTokens: 1, outputTokens: 2 };
    const result = costBreakdown([
      report([paid, paid], false, "error"), // both charged attempts count, even on error
      report([estimate, free, unpriced]), report([]), report([paid], true), report([], true),
    ]);
    expect(result.liveCalls).toBe(3);
    expect(result.replayedCalls).toBe(2);
    expect(result.unmeteredLiveCalls).toBe(1);
    expect(result.unmeteredReplayedCalls).toBe(1);
    expect(result.live).toEqual({ requests: 5, providerUsd: 0.04, estimatedUsd: 0.001,
      unpricedRequests: 1, inputTokens: 401, outputTokens: 42,
      cacheReadTokens: 80, cacheWriteTokens: 120 });
    expect(result.replayed.providerUsd).toBe(0.02);
    expect(result.groups).toHaveLength(3);
    expect(result.groups.find(g => g.stage === "screen")?.live.estimatedUsd).toBe(0.001);
    expect(costBreakdown([]).live.requests).toBe(0);
  });

  it("rejects invalid money and counts instead of producing a misleading total", () => {
    for (const usd of [-1, NaN, Infinity]) expect(() => costBreakdown([report([
      { model: "m", inputTokens: 1, outputTokens: 1, cost: { usd, source: "provider" } },
    ])])).toThrow(/invalid usage cost/);
    expect(() => costBreakdown([report([
      { model: "m", inputTokens: NaN, outputTokens: 1 },
    ])])).toThrow(/invalid usage inputTokens/);
  });

  it("Jev journals a configured cost estimate and replays it without new provider spend", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "jev-pinned", answers: { q: { type: "noul", noul: 0.9 } },
      usage: { input_tokens: 1000, output_tokens: 20 },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const journalPath = join(mkdtempSync(join(tmpdir(), "heddle-cost-")), "run.jsonl");
    const script = async (w: Workflow) => w.feels("state", "question");
    const jev = judge({ apiKey: "test", inputUsdPerMillion: 0.042, stage: "screen" });
    const reports: CallReport[] = [];
    const backend = async () => "unused";
    await run(script, { backend, judge: jev, journalPath, onCall: c => reports.push(c) });
    const entry = JSON.parse(readFileSync(journalPath, "utf8").trim()) as { usage: Usage[] };
    expect(entry.usage[0]).toMatchObject({ model: "jev-pinned", provider: "typesafe",
      stage: "screen", inputTokens: 1000, outputTokens: 20,
      cost: { usd: 0.000042, source: "estimate" } });
    await run(script, { backend, judge: jev, journalPath, resume: true,
      onCall: c => reports.push(c) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(costBreakdown(reports).live.estimatedUsd).toBeCloseTo(0.000042);
    expect(costBreakdown(reports).replayed.estimatedUsd).toBeCloseTo(0.000042);
    expect(reports[1]?.usage).toEqual(entry.usage);
  });

  it("meters returned Jev usage before rejecting malformed answers; no rate means unpriced", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      usage: { input_tokens: 4, output_tokens: 1 }, answers: null,
    }))));
    const entries: Usage[] = [];
    await expect(judge({ apiKey: "test" })({ state: "s", questions: {},
      meter: u => entries.push(u) })).rejects.toThrow(/no answers/);
    const result = costBreakdown([report(entries, false, "error")]);
    expect(result.live.unpricedRequests).toBe(1);
    expect(result.live.estimatedUsd).toBe(0);
    expect(() => judge({ apiKey: "test", inputUsdPerMillion: -1 })).toThrow(/nonnegative/);
  });
});
