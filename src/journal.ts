/**
 * The journal: one JSON line per settled model call. It is both the debugging surface (every
 * return value, error, and timing is on disk) and the resume mechanism.
 *
 * Replay is content-addressed, not prefix-ordered: an entry is keyed on a hash of
 * (prompt, semantic opts) plus an occurrence counter for byte-identical repeats. Under
 * concurrency the *completion* order of agent calls varies run to run (network latency decides
 * which pipeline chain advances first), so "the longest unchanged prefix" of a journal is not a
 * well-defined thing to replay — but the *set* of calls a deterministic script makes is stable,
 * and a call whose (prompt, opts) is unchanged returns its cached result no matter where in the
 * interleaving it happens. Editing a late stage therefore re-runs only the calls whose inputs
 * actually changed, which is the affordability property the prefix rule was reaching for.
 *
 * Only successful calls are cached; errors are journaled for the record but re-run on resume.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

import type { AgentOptions, Question } from "./types.ts";

/** What was asked, and of whom. */
export type JournalRecord =
  | { kind: "agent"; prompt: string; opts: AgentOptions; context?: string }
  | { kind: "judge"; state: unknown; question: Question; model: string | null };

/** How it went. */
export type JournalOutcome = { status: "ok"; result: unknown } | { status: "error"; error: string };

/** One settled model call, as the scheduler hands it to the journal. */
export type SettledCall = JournalRecord &
  JournalOutcome & { key: string; occurrence: number; ms: number };

/** One journal line: a settled call with its sequence number. */
export type JournalEntry = SettledCall & { seq: number };

/** Stable stringify (sorted object keys, recursively) so hashing ignores key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

/** The cache key for one agent call: the prompt plus the opts that change the model's answer. */
export function callKey(prompt: string, opts: AgentOptions): string {
  const semantic = {
    model: opts.model ?? null,
    schema: opts.schema ?? null,
    system: opts.system ?? null,
    maxTokens: opts.maxTokens ?? null,
  };
  return digest({ prompt, semantic });
}

/** The cache key for one judgment: the state, the question, and the judge model. */
export function judgeKey(state: unknown, question: Question, model: string | undefined): string {
  return digest({ judge: { state, question, model: model ?? null } });
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 32);
}

export class Journal {
  readonly path: string | null;
  seq = 0;
  /** key -> cached results in occurrence order (only status "ok" entries). */
  private readonly cache = new Map<string, Array<{ result: unknown } | undefined>>();
  /** key -> how many occurrences this run has consumed (replay) or produced (live). */
  private readonly consumed = new Map<string, number>();

  /** @param path JSONL file; null journals nothing and caches nothing. */
  constructor(path: string | null, { resume = false }: { resume?: boolean } = {}) {
    this.path = path;
    if (path && resume && existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as JournalEntry;
        this.seq = Math.max(this.seq, entry.seq ?? 0);
        if (entry.status !== "ok") continue;
        let occurrences = this.cache.get(entry.key);
        if (!occurrences) {
          occurrences = [];
          this.cache.set(entry.key, occurrences);
        }
        occurrences[entry.occurrence] = { result: entry.result };
      }
    }
  }

  /** Next occurrence index for this key in issuance order (deterministic per script). */
  nextOccurrence(key: string): number {
    const n = this.consumed.get(key) ?? 0;
    this.consumed.set(key, n + 1);
    return n;
  }

  /** A cached success for (key, occurrence), or undefined. */
  replay(key: string, occurrence: number): { result: unknown } | undefined {
    return this.cache.get(key)?.[occurrence];
  }

  append(entry: SettledCall): JournalEntry {
    this.seq += 1;
    const record: JournalEntry = { seq: this.seq, ...entry };
    if (this.path) appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    return record;
  }
}
