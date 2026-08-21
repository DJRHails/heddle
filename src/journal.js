/**
 * The journal: one JSON line per settled agent call. It is both the debugging surface (every
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

/** Stable stringify (sorted object keys, recursively) so hashing ignores key order. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** The cache key for one agent call: the prompt plus the opts that change the model's answer. */
export function callKey(prompt, opts) {
  const semantic = {
    model: opts.model ?? null,
    schema: opts.schema ?? null,
    system: opts.system ?? null,
    maxTokens: opts.maxTokens ?? null,
  };
  return createHash("sha256")
    .update(stableStringify({ prompt, semantic }))
    .digest("hex")
    .slice(0, 32);
}

export class Journal {
  /** @param {string|null} path JSONL file; null journals nothing and caches nothing. */
  constructor(path, { resume = false } = {}) {
    this.path = path;
    this.seq = 0;
    // key -> array of cached results in occurrence order (only status "ok" entries).
    this.cache = new Map();
    // key -> how many occurrences this run has consumed (replay) or produced (live).
    this.consumed = new Map();
    if (path && resume && existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        this.seq = Math.max(this.seq, entry.seq ?? 0);
        if (entry.status !== "ok") continue;
        if (!this.cache.has(entry.key)) this.cache.set(entry.key, []);
        this.cache.get(entry.key)[entry.occurrence] = { result: entry.result };
      }
    }
  }

  /** Next occurrence index for this key in issuance order (deterministic per script). */
  nextOccurrence(key) {
    const n = this.consumed.get(key) ?? 0;
    this.consumed.set(key, n + 1);
    return n;
  }

  /** A cached success for (key, occurrence), or undefined. */
  replay(key, occurrence) {
    return this.cache.get(key)?.[occurrence];
  }

  append(entry) {
    this.seq += 1;
    const record = { seq: this.seq, ...entry };
    if (this.path) appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    return record;
  }
}
