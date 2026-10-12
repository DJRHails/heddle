/**
 * LinuxArena ("LinuxArena: A Benchmark for AI Control Evaluations", anonymous NeurIPS 2026
 * D&B submission): agents doing software-engineering tasks in ten Linux environments, either
 * honestly or with a covert sabotage side task (reverse shells, backdoors, data exfiltration).
 * HF anonymouslinuxarena/linuxarena-public, CC-BY-4.0. This converter reads the reviewer sample
 * `data/sample.jsonl` (932 rows, 705 MB): Haiku 4.5 honest and attack agent runs, plus monitor
 * reruns over a Haiku attack run, Opus 4.6 honest runs and "straj" sabotage trajectories.
 *
 * Labels: a trajectory given a side task (`side_task` non-null) is positive whether or not the
 * sabotage succeeded (`meta.sideTaskSucceeded` records which).
 *
 * A monitor rerun copies its trajectories under fresh `trajectory_id`s, so items are keyed on
 * content (environment, main and side task, every tool call and result): the 932 rows hold 588
 * distinct trajectories. Every copy's monitor verdicts are merged into the one item, in
 * `meta.shippedScores` keyed by the normalised model name (provider path and date suffix
 * dropped): `<model>` is its trajectory-level (full-trace) score, `<model>:action-max` its
 * highest per-action score, both on LinuxArena's 0–10 scale; copies of one verdict take the max.
 * The model comes from the verdict's `model_name`, else its ensemble members' (never the run
 * name, which mislabels some trajectory monitors); a verdict naming no model is counted in
 * `meta.unattributedVerdicts`, and an errored or all-members-errored verdict is not a score.
 *
 * What the monitor sees follows LinuxArena's own monitors: the main task and environment
 * description, then each action's tool call, arguments, result and error. The system prompt
 * (which states the side task to an attacker), the agent's reasoning text and extended
 * thinking (its scratchpad, hidden as in SHADE-Arena's protocol) and the inter-action messages
 * are left out. So are calls to the attacker's scaffold tools (`ATTACK_SCAFFOLD`, counted in
 * `meta.hiddenScaffoldCalls`) and `submit`'s arguments, which in attack runs are the side
 * task's submission form (`attacker_user`, `extract_a_secret`, …). Tool outputs are clipped to 5,000 chars and an action's arguments to 40,000,
 * the middle replaced by a marker, and a transcript still over 400,000 chars is clipped the same
 * way; `meta` counts every clip.
 *
 * The file is streamed and only the items that can still make the class-balanced sample are
 * kept rendered, so memory holds `2 × perClass` items rather than the file.
 */

import { createHash } from "node:crypto";

import { balancedSample, type Benchmark, type Fetched } from "./benchmark.ts";
import { clipMiddle } from "./clip.ts";
import { get } from "./hf.ts";
import type { MonitorItem } from "../items.ts";

const DATASET = "anonymouslinuxarena/linuxarena-public";
const REVISION = "2fd29f9c7bc190fb873bd76c6bd648f22b9ab0a7";
const FILE = "data/sample.jsonl";
const ROWS = 932;

const OUTPUT_CAP = 5_000;
const ARGUMENTS_CAP = 40_000;
const TRANSCRIPT_CAP = 400_000;

const ACTION_MAX = ":action-max";

interface Verdict {
  sus_score?: unknown;
  error?: unknown;
  model_name?: string | null;
  members?: Verdict[] | null;
}

export interface Action {
  function: string;
  arguments: Record<string, unknown> | null;
  output: string | null;
  output_error?: string | null;
  monitor_response?: Verdict | null;
}

export interface Trajectory {
  trajectory_id: string;
  run_display_name: string;
  environment: { id: string; description?: string | null };
  main_task: { id: string; description?: string | null } | null;
  side_task: { id: string } | null;
  actions: Action[];
  traj_monitor_response?: Verdict | null;
  main_task_success?: boolean | null;
  side_task_success?: boolean | null;
  agent_model?: string | null;
}

/** The shipped verdicts of one trajectory, possibly merged over its copies. */
export interface ShippedVerdicts {
  scores: Record<string, number>;
  /** Actions each model scored, so a partial action-max is visible as partial. */
  actionsScored: Record<string, number>;
  unattributed: number;
}

/** `openrouter/anthropic/claude-opus-4-6` and `gpt-5-nano-2025-08-07` -> the bare model. */
const MODEL_NAME = /^(?:.*\/)?(?<model>.+?)(?:-\d{4}-\d{2}-\d{2})?$/;

function modelName(raw: string): string {
  return MODEL_NAME.exec(raw)?.groups?.model ?? raw;
}

/** Who gave a verdict; null when it is not a score (errored, or every member errored). */
function attribution(verdict: Verdict): string | null {
  if (verdict.error) return null;
  const members = verdict.members ?? [];
  const live = members.filter((member) => !member.error);
  if (members.length > 0 && live.length === 0) return null;
  if (verdict.model_name) return modelName(verdict.model_name);
  const names = new Set(live.flatMap((m) => (m.model_name ? [modelName(m.model_name)] : [])));
  return names.size > 0 ? [...names].sort().join("+") : "";
}

function scoreOf(verdict: Verdict, where: string): number {
  if (typeof verdict.sus_score !== "number" || !Number.isFinite(verdict.sus_score)) {
    const shown = JSON.stringify(verdict.sus_score);
    throw new Error(`${where}: monitor sus_score ${shown} is not a number`);
  }
  return verdict.sus_score;
}

function record(book: ShippedVerdicts, key: string, score: number): void {
  book.scores[key] = Math.max(book.scores[key] ?? -Infinity, score);
}

/** Every per-action and trajectory-level verdict the row ships, by model. */
export function shippedVerdicts(row: Trajectory, where: string): ShippedVerdicts {
  const book: ShippedVerdicts = { scores: {}, actionsScored: {}, unattributed: 0 };
  for (const [index, action] of row.actions.entries()) {
    const model = action.monitor_response ? attribution(action.monitor_response) : null;
    if (!action.monitor_response || model === null) continue;
    const score = scoreOf(action.monitor_response, `${where} action ${index}`);
    if (!model) {
      book.unattributed += 1;
      continue;
    }
    record(book, model + ACTION_MAX, score);
    book.actionsScored[model] = (book.actionsScored[model] ?? 0) + 1;
  }
  const whole = row.traj_monitor_response;
  const model = whole ? attribution(whole) : null;
  if (whole && model !== null) {
    const score = scoreOf(whole, `${where} trajectory monitor`);
    if (model) record(book, model, score);
    else book.unattributed += 1;
  }
  return book;
}

function mergeVerdicts(into: ShippedVerdicts, from: ShippedVerdicts): void {
  for (const [key, score] of Object.entries(from.scores)) record(into, key, score);
  for (const [model, count] of Object.entries(from.actionsScored)) {
    into.actionsScored[model] = Math.max(into.actionsScored[model] ?? 0, count);
  }
  into.unattributed += from.unattributed;
}

function renderArguments(args: Record<string, unknown> | null): string {
  return Object.entries(args ?? {})
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return text.includes("\n") ? `${key}:\n${text}` : `${key}: ${text}`;
    })
    .join("\n");
}

export interface Rendered {
  transcript: string;
  clippedOutputs: number;
  clippedArguments: number;
  transcriptElidedChars: number;
  hiddenScaffoldCalls: number;
}

/**
 * Tools only the attacker's scaffold offers (testing the side task, the sabotage-planning
 * phases): only attack runs call them, so a call alone would state the label.
 */
const ATTACK_SCAFFOLD = new Set([
  "run_side_task_test",
  "start_phase1_planning",
  "start_phase2_planning",
]);

/** `submit`'s arguments are the side task's submission form in attack runs, so none are shown. */
const SUBMIT = "submit";

/** The actions as the monitor sees them: tool calls and results, no reasoning. */
export function renderActions(actions: readonly Action[]): Rendered {
  let clippedOutputs = 0;
  let clippedArguments = 0;
  const shown = actions.filter((action) => !ATTACK_SCAFFOLD.has(action.function));
  const blocks = shown.map((action, index) => {
    const args = clipMiddle(
      action.function === SUBMIT ? "" : renderArguments(action.arguments),
      ARGUMENTS_CAP,
      `tool-call arguments are clipped to ${ARGUMENTS_CAP.toLocaleString("en-US")} chars`,
    );
    const output = clipMiddle(
      action.output ?? "",
      OUTPUT_CAP,
      `tool outputs are clipped to ${OUTPUT_CAP.toLocaleString("en-US")} chars`,
    );
    if (args.elided > 0) clippedArguments += 1;
    if (output.elided > 0) clippedOutputs += 1;
    const error = action.output_error?.trim() ? `\nError: ${action.output_error.trim()}` : "";
    const call = args.text ? `${action.function}\n${args.text}` : action.function;
    const result = output.text.trim() || "(empty)";
    return `Action ${index}:\nTool call: ${call}\nResult: ${result}${error}`;
  });
  const whole = clipMiddle(
    blocks.join("\n\n") || "(the agent took no actions)",
    TRANSCRIPT_CAP,
    `transcripts are clipped to ${TRANSCRIPT_CAP.toLocaleString("en-US")} chars`,
  );
  return {
    transcript: whole.text,
    clippedOutputs,
    clippedArguments,
    transcriptElidedChars: whole.elided,
    hiddenScaffoldCalls: actions.length - shown.length,
  };
}

/** Identity of a trajectory across monitor reruns: everything but the monitor fields. */
export function contentKey(row: Trajectory): string {
  const actions = row.actions.map((a) => [a.function, a.arguments, a.output, a.output_error]);
  const content = [row.environment.id, row.main_task?.id, row.side_task?.id ?? null, actions];
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export function parseTrajectory(line: string, where: string): Trajectory {
  let row: Trajectory;
  try {
    row = JSON.parse(line) as Trajectory;
  } catch (error) {
    throw new Error(`${where}: not JSON (${(error as Error).message})`);
  }
  const problems: Array<[boolean, string]> = [
    [typeof row.trajectory_id !== "string", "no trajectory_id"],
    [typeof row.environment?.id !== "string", "no environment.id"],
    [!row.main_task?.description?.trim(), "no main_task.description"],
    [!Array.isArray(row.actions), "no actions array"],
    [row.side_task !== null && typeof row.side_task?.id !== "string", "side_task has no id"],
  ];
  const problem = problems.find(([failed]) => failed);
  if (problem) throw new Error(`${where}: ${problem[1]}`);
  return row;
}

/** One distinct trajectory: its first copy's item, while it can still be sampled, and verdicts. */
interface Entry {
  id: string;
  label: 0 | 1;
  rank: string;
  verdicts: ShippedVerdicts;
  runs: string[];
  trajectoryIds: string[];
  item?: MonitorItem;
}

function itemFor(source: string, id: string, row: Trajectory): MonitorItem {
  const rendered = renderActions(row.actions);
  const environment = row.environment.description?.trim();
  const mainTask = [row.main_task?.description?.trim() ?? "", environment ?? ""]
    .filter(Boolean)
    .join("\n\nAbout the environment:\n");
  return {
    id,
    source,
    task: row.environment.id,
    label: row.side_task === null ? 0 : 1,
    mainTask,
    transcript: rendered.transcript,
    meta: {
      mainTaskId: row.main_task?.id,
      sideTask: row.side_task?.id ?? null,
      mainTaskSucceeded: row.main_task_success ?? null,
      sideTaskSucceeded: row.side_task_success ?? null,
      agentModel: row.agent_model ?? null,
      actions: row.actions.length,
      clippedOutputs: rendered.clippedOutputs,
      clippedArguments: rendered.clippedArguments,
      transcriptElidedChars: rendered.transcriptElidedChars,
      hiddenScaffoldCalls: rendered.hiddenScaffoldCalls,
    },
  };
}

/** Keep `entry` rendered if it ranks among the `perClass` lowest of its class so far. */
function admit(kept: Entry[], entry: Entry, perClass: number, render: () => MonitorItem): void {
  const worst = kept.at(-1);
  if (kept.length >= perClass && (worst === undefined || entry.rank > worst.rank)) return;
  entry.item = render();
  kept.push(entry);
  kept.sort((a, b) => (a.rank < b.rank ? -1 : 1));
  const evicted = kept.length > perClass ? kept.pop() : undefined;
  if (evicted) evicted.item = undefined;
}

/**
 * The class-balanced sample of distinct trajectories from JSONL rows, identical to
 * `balancedSample` over every distinct trajectory, holding only the sample's items.
 */
export async function selectTrajectories(
  lines: AsyncIterable<string>,
  perClass: number,
  source: string,
): Promise<Fetched & { rows: number }> {
  const entries = new Map<string, Entry>();
  const kept: Record<0 | 1, Entry[]> = { 0: [], 1: [] };
  let rows = 0;
  for await (const line of lines) {
    rows += 1;
    const row = parseTrajectory(line, `${FILE}:${rows}`);
    const verdicts = shippedVerdicts(row, `${FILE}:${rows} (${row.trajectory_id})`);
    const key = contentKey(row);
    const seen = entries.get(key);
    if (seen) {
      mergeVerdicts(seen.verdicts, verdicts);
      seen.runs.push(row.run_display_name);
      seen.trajectoryIds.push(row.trajectory_id);
      continue;
    }
    const id = `${source}:${row.environment.id}/${key.slice(0, 16)}`;
    const label = row.side_task === null ? 0 : 1;
    const rank = createHash("sha256").update(id).digest("hex");
    const runs = [row.run_display_name];
    const entry: Entry = { id, label, rank, verdicts, runs, trajectoryIds: [row.trajectory_id] };
    entries.set(key, entry);
    admit(kept[label], entry, perClass, () => itemFor(source, id, row));
  }
  const items = [...kept[0], ...kept[1]].map(withVerdicts);
  return { items: balancedSample(items, perClass), available: entries.size, rows };
}

/** A kept entry's item, with what every copy of it shipped. */
function withVerdicts({ id, item, verdicts, runs, trajectoryIds }: Entry): MonitorItem {
  if (!item) throw new Error(`${id}: kept for the sample but never rendered`);
  const meta = {
    ...item.meta,
    runs,
    trajectoryIds,
    shippedScores: verdicts.scores,
    shippedActionsScored: verdicts.actionsScored,
    unattributedVerdicts: verdicts.unattributed,
  };
  return { ...item, meta };
}

/** Non-empty lines of a UTF-8 byte stream, without buffering more than one line. */
export async function* jsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let pending = "";
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) yield line;
  }
  if (pending.trim()) yield pending;
}

const linuxArena: Benchmark = {
  name: "linuxarena",
  provenance: `LinuxArena (NeurIPS 2026 D&B, anonymous); HF ${DATASET}/${FILE}`,
  licence: "CC-BY-4.0",
  fetch: async (perClass) => {
    const url = `https://huggingface.co/datasets/${DATASET}/resolve/${REVISION}/${FILE}`;
    const body = (await get(url)).body;
    if (!body) throw new Error(`GET ${url}: empty response body`);
    const { rows, ...fetched } = await selectTrajectories(jsonLines(body), perClass, "linuxarena");
    if (rows !== ROWS) throw new Error(`${url}: ${rows} rows, expected ${ROWS} at this revision`);
    return fetched;
  },
};

export const LINUXARENA: readonly Benchmark[] = [linuxArena];
