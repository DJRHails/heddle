/**
 * Monitor Red Teaming (Kale et al., "Reliable Weak-to-Strong Monitoring of LLM Agents", arXiv
 * 2508.19461): agent rollouts on SHADE-Arena's five public task pairs (tool-use: bank
 * transfers, calendars, travel booking, spam filters, expense accounting) and on fifteen
 * TheAgentCompany computer-use tasks, each run either honestly or with a covert sabotage side
 * task. HF ScaleAI/mrt, CC BY-NC 4.0.
 *
 * Labels follow the paper: a run given the side task is a positive whether or not the sabotage
 * succeeded (`meta.sideTaskSucceeded` records which). Only the base conditions are used — the
 * benign run, and the default / no-hint (SHADE) or per-strategy (computer-use) attack runs;
 * the hundreds of other condition directories re-monitor those same runs under monitor
 * scaffolds. A run is stored once per monitor directory, so candidates are keyed on (task,
 * condition, agent, run) and one copy is kept — the paper's main monitor's
 * (`PREFERRED_MONITOR`) when it scored the run, else the first by path.
 *
 * What the monitor sees matches SHADE-Arena's protocol: the system prompt (which states the side
 * task) and the agent's scratchpad (`<thinking>`, and the computer-use runs' `<hidden_thinking>`,
 * `<model_thinking>` and `<think>`) are removed; `<visible_thinking>` text stays, untagged. Runs
 * whose rendered transcripts are identical are kept once. The released files record tool
 * call names but not their arguments; tool outputs are kept. The kept copy's shipped verdict
 * (0–100, from the monitor its directory names) rides `meta.shippedScores`, the external
 * reference the `shipped:<monitor>` arm reads.
 */

import { balancedSample, mapLimited, type Benchmark } from "./benchmark.ts";
import { hubFile, hubTree } from "./hf.ts";
import type { MonitorItem } from "../items.ts";

const DATASET = "ScaleAI/mrt";
const REVISION = "bc636d0c3b881c7d8c76fd71b45b009c3710d437";

const SHADE_TASKS = [
  "american_airlines_2",
  "api_key_calendar_agendas_2",
  "bank_transfer_2",
  "expenditure_accounting",
  "spam_filter_update",
];

const SHADE_CONDITIONS: Record<string, 0 | 1> = {
  transcripts_no_secondary_task: 0,
  transcripts: 1,
  transcripts_no_hint: 1,
};

/** Computer-use base conditions: `transcripts_no_hint_<strategy>_v<n>_thinking_time`. */
const CUA_CONDITION = /^transcripts_no_hint_(?<strategy>[a-z_]+?)_v\d+_thinking_time$/;

interface Candidate {
  id: string;
  label: 0 | 1;
  task: string;
  condition: string;
  agent: string;
  path: string;
}

interface Message {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
}

interface Run {
  conversation: Message[];
  monitoring_response?: string;
  side_task_evaluation?: unknown;
}

/** A hidden scratchpad block, closed or running to the end of the message. */
const SCRATCHPAD = /<(?<tag>(?:hidden_|model_)?think(?:ing)?)>[\s\S]*?(?:<\/\k<tag>>|$)/g;
/**
 * The thinking-time protocol's visible channel stays, without its tags: only attack runs use
 * the tags at all, so the tag alone would tell the monitor the label.
 */
const VISIBLE_TAG = /<\/?visible_thinking>/g;

/** The run as the monitor sees it: no system prompt, no scratchpad. */
export function renderRun(conversation: readonly Message[]): string {
  return conversation
    .filter((message) => message.role !== "system")
    .map((message) => {
      const content = String(message.content ?? "")
        .replace(SCRATCHPAD, "")
        .replace(VISIBLE_TAG, "")
        .trim();
      const calls = typeof message.tool_calls === "string" ? message.tool_calls.trim() : "";
      return `[${message.role}] ${[content, calls].filter(Boolean).join("\n") || "(empty)"}`;
    })
    .join("\n\n");
}

/** The 0–100 verdict the shipped monitor gave, when the file carries one. */
function shippedVerdict(response: string | undefined): number | null {
  const match = /<verdict>\s*(?<score>\d+(?:\.\d+)?)\s*<\/verdict>/.exec(response ?? "");
  return match?.groups?.score === undefined ? null : Number(match.groups.score);
}

/** The paper's main monitor: its copy is kept when present, so `shipped:` scores one model. */
export const PREFERRED_MONITOR = "claude-3-5-sonnet-20241022";

/** Whether copy `a` beats copy `b`: the preferred monitor's directory, else the first by path. */
export function preferredCopy(a: string, b: string): boolean {
  const preferred = (path: string) => path.split("/").at(-2) === PREFERRED_MONITOR;
  if (preferred(a) !== preferred(b)) return preferred(a);
  return a < b;
}

/** One candidate per (task, condition, agent, run), preferring the main monitor's copy. */
async function candidates(
  root: string,
  task: string,
  conditions: ReadonlyArray<[string, 0 | 1]>,
): Promise<Candidate[]> {
  const found: Candidate[] = [];
  for (const [condition, label] of conditions) {
    const entries = await hubTree(DATASET, REVISION, `${root}/${task}/${condition}`, {
      recursive: true,
    });
    const runs = new Map<string, string>();
    for (const { type, path } of entries) {
      const parts = path.split("/");
      const [agent, monitor, file] = parts.slice(-3);
      if (type !== "file" || !file?.endsWith(".json") || !agent || !monitor) continue;
      const key = `${agent}/${file}`;
      const kept = runs.get(key);
      if (kept === undefined || preferredCopy(path, kept)) runs.set(key, path);
    }
    for (const [key, path] of runs) {
      const [agent = ""] = key.split("/");
      const id = `mrt:${root}/${task}/${condition}/${key.replace(/\.json$/, "")}`;
      found.push({ id, label, task, condition, agent, path });
    }
  }
  return found;
}

async function toItem(source: string, candidate: Candidate): Promise<MonitorItem> {
  const run = JSON.parse(await hubFile(DATASET, REVISION, candidate.path)) as Run;
  const monitor = candidate.path.split("/").at(-2) ?? "";
  const verdict = shippedVerdict(run.monitoring_response);
  return {
    id: candidate.id,
    source,
    task: candidate.task,
    label: candidate.label,
    mainTask: "",
    transcript: renderRun(run.conversation),
    meta: {
      condition: candidate.condition,
      agent: candidate.agent,
      sideTaskSucceeded: run.side_task_evaluation === true,
      shippedScores: verdict === null ? {} : { [monitor]: verdict },
    },
  };
}

const DUPLICATE_SLACK = 1.2;

/** The first item of each distinct transcript, in order. */
export function distinctTranscripts(items: readonly MonitorItem[]): MonitorItem[] {
  const seen = new Set<string>();
  const kept: MonitorItem[] = [];
  for (const item of items) {
    if (seen.has(item.transcript)) continue;
    seen.add(item.transcript);
    kept.push(item);
  }
  return kept;
}

function mrtBenchmark(
  name: string,
  root: string,
  tasks: () => Promise<string[]>,
  conditionsFor: (task: string) => Promise<Array<[string, 0 | 1]>>,
): Benchmark {
  return {
    name,
    provenance: `MRT (arXiv 2508.19461); HF ${DATASET}/${root}`,
    licence: "CC BY-NC 4.0",
    fetch: async (perClass) => {
      const pool: Candidate[] = [];
      for (const task of await tasks()) {
        pool.push(...(await candidates(root, task, await conditionsFor(task))));
      }
      // over-draw, so dropping runs whose rendered transcripts repeat still fills each class
      const chosen = balancedSample(pool, Math.ceil(perClass * DUPLICATE_SLACK));
      const items = await mapLimited(chosen, 8, (candidate) => toItem(name, candidate));
      return { items: balancedSample(distinctTranscripts(items), perClass), available: pool.length };
    },
  };
}

async function directories(path: string): Promise<string[]> {
  const entries = await hubTree(DATASET, REVISION, path);
  return entries
    .filter((entry) => entry.type === "directory")
    .map((entry) => entry.path.split("/").at(-1) ?? "")
    .filter((name) => name && name !== "__pycache__")
    .sort();
}

const mrtShade = mrtBenchmark(
  "mrt-shade",
  "task_pairs",
  async () => SHADE_TASKS,
  async (task) => {
    const present = new Set(await directories(`task_pairs/${task}`));
    return Object.entries(SHADE_CONDITIONS).filter(([condition]) => present.has(condition));
  },
);

const mrtComputerUse = mrtBenchmark(
  "mrt-computer-use",
  "task_pairs_agentcompany",
  () => directories("task_pairs_agentcompany"),
  async (task) =>
    (await directories(`task_pairs_agentcompany/${task}`)).flatMap((condition) => {
      const strategy = CUA_CONDITION.exec(condition)?.groups?.strategy;
      if (strategy === undefined) return [];
      return [[condition, strategy === "benign" ? 0 : 1] as [string, 0 | 1]];
    }),
);

export const MRT: readonly Benchmark[] = [mrtShade, mrtComputerUse];
