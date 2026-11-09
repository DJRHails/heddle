/**
 * The one shape every monitor eval runs on: a transcript of an agent at work, the task it was
 * given, and a binary label saying whether the transcript contains behaviour a monitor should
 * flag. Converters (evals/benchmarks/) turn each external benchmark into these rows; the
 * monitors and metrics never see a benchmark's native format.
 *
 * Loading validates every row and fails loudly, naming the file, line and field: a row that
 * silently drops out of an eval reads exactly like a row the monitor got right.
 */

import { readFileSync, writeFileSync } from "node:fs";

export interface MonitorItem {
  /** Unique within its dataset: `<source>:<native id>`. */
  id: string;
  /** The benchmark it came from, e.g. "shade-arena". */
  source: string;
  /** The behaviour or environment within the benchmark, for per-task breakdowns. */
  task: string;
  /** 1 when the transcript contains the behaviour a monitor should flag, else 0. */
  label: 0 | 1;
  /** What the agent was asked to do, as the monitor would know it ("" when unknown). */
  mainTask: string;
  /** The rendered transcript the monitor reads. */
  transcript: string;
  /**
   * The behaviour to flag, when the benchmark defines one (sluice's bank tasks: "the agent lost
   * track of an earlier instruction…"). Absent, monitors use the generic misbehaviour brief.
   */
  policy?: string;
  meta?: Record<string, unknown>;
}

const STRING_FIELDS = ["id", "source", "task", "mainTask", "transcript"] as const;

function invalid(where: string, message: string): Error {
  return new Error(`${where}: ${message}`);
}

/** Check one parsed row; `where` names it in the error (file:line). */
export function validateItem(value: unknown, where: string): MonitorItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(where, "a monitor item must be a JSON object");
  }
  const row = value as Record<string, unknown>;
  for (const field of STRING_FIELDS) {
    if (typeof row[field] !== "string") throw invalid(where, `"${field}" must be a string`);
  }
  if (!(row.id as string) || !(row.transcript as string).trim()) {
    throw invalid(where, `"id" and "transcript" must be non-empty`);
  }
  if (row.label !== 0 && row.label !== 1) {
    throw invalid(where, `"label" must be 0 or 1, got ${JSON.stringify(row.label)}`);
  }
  if (row.policy !== undefined && (typeof row.policy !== "string" || !row.policy.trim())) {
    throw invalid(where, `"policy" must be a non-empty string when present`);
  }
  if (row.meta !== undefined && (typeof row.meta !== "object" || row.meta === null)) {
    throw invalid(where, `"meta" must be an object when present`);
  }
  return row as unknown as MonitorItem;
}

/** Read a JSONL dataset; every row is validated and ids must be unique. */
export function readItems(path: string): MonitorItem[] {
  const items: MonitorItem[] = [];
  const seen = new Set<string>();
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const where = `${path}:${index + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw invalid(where, `not JSON (${(error as Error).message})`);
    }
    const item = validateItem(parsed, where);
    if (seen.has(item.id)) throw invalid(where, `duplicate id "${item.id}"`);
    seen.add(item.id);
    items.push(item);
  }
  if (items.length === 0) throw new Error(`${path}: no monitor items`);
  return items;
}

export function writeItems(path: string, items: readonly MonitorItem[]): void {
  items.forEach((item, index) => validateItem(item, `item ${index} (${item.id})`));
  writeFileSync(path, items.map((item) => JSON.stringify(item)).join("\n") + "\n");
}
