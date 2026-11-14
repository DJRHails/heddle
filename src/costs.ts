import type { CallReport, Usage } from "./types.ts";

export interface CostTotals {
  requests: number;
  providerUsd: number;
  estimatedUsd: number;
  unpricedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CostGroup {
  kind: CallReport["kind"];
  provider: string | null;
  model: string;
  stage: string | null;
  live: CostTotals;
  replayed: CostTotals;
}

export interface CostBreakdown {
  liveCalls: number;
  replayedCalls: number;
  unmeteredLiveCalls: number;
  unmeteredReplayedCalls: number;
  live: CostTotals;
  /** Historical usage recovered from the journal; never new spend. */
  replayed: CostTotals;
  groups: CostGroup[];
}

function empty(): CostTotals {
  return {
    requests: 0, providerUsd: 0, estimatedUsd: 0, unpricedRequests: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  };
}

function add(total: CostTotals, usage: Usage): void {
  const counts = {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  };
  for (const [name, value] of Object.entries(counts)) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`invalid usage ${name}`);
  }
  if (usage.cost && (!Number.isFinite(usage.cost.usd) || usage.cost.usd < 0 ||
    !["provider", "estimate"].includes(usage.cost.source))) {
    throw new TypeError("invalid usage cost");
  }
  total.requests++;
  for (const name of Object.keys(counts) as Array<keyof typeof counts>) total[name] += counts[name];
  if (!usage.cost) total.unpricedRequests++;
  else if (usage.cost.source === "provider") total.providerUsd += usage.cost.usd;
  else total.estimatedUsd += usage.cost.usd;
}

/** Summarise onCall reports, including failed calls and every metered retry. No price lookup. */
export function costBreakdown(reports: Iterable<CallReport>): CostBreakdown {
  const result: CostBreakdown = {
    liveCalls: 0, replayedCalls: 0, unmeteredLiveCalls: 0, unmeteredReplayedCalls: 0,
    live: empty(), replayed: empty(), groups: [],
  };
  const groups = new Map<string, CostGroup>();
  for (const report of reports) {
    const bucket = report.replayed ? "replayed" : "live";
    if (report.replayed) result.replayedCalls++;
    else result.liveCalls++;
    if (!report.usage.length) {
      if (report.replayed) result.unmeteredReplayedCalls++;
      else result.unmeteredLiveCalls++;
    }
    for (const usage of report.usage) {
      const dimensions = {
        kind: report.kind, provider: usage.provider ?? null,
        model: usage.model, stage: usage.stage ?? null,
      };
      const key = JSON.stringify(dimensions);
      let group = groups.get(key);
      if (!group) {
        group = { ...dimensions, live: empty(), replayed: empty() };
        groups.set(key, group);
      }
      add(result[bucket], usage);
      add(group[bucket], usage);
    }
  }
  result.groups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g);
  return result;
}
