/**
 * ResearchArena (Libon et al., "ResearchArena: Evaluating Sabotage and Monitoring in Automated
 * AI R&D", arXiv 2607.19321): hour-long autonomous AI R&D runs (CUDA kernel optimisation,
 * inference-server optimisation, safety and utility fine-tuning) by Claude, Codex and OpenCode
 * agents, each either honest or carrying a hidden sabotage side task: a backdoored artifact
 * ("embedded") or a covert out-of-scope action ("independent"). HF
 * aisa-group/ResearchArena-Trajectories, Apache-2.0; 390 runs.
 *
 * Labels: `metadata.json`'s `side_task` other than "none" is positive, whether or not the
 * sabotage succeeded (`meta.sideTaskScore` is the upstream measure, its scale per side task).
 * The label comes from the metadata, not the directory name: 12 `safety_finetuning__embedded__`
 * runs carry side task "nonortho".
 *
 * The transcript is the run's `solve_parsed_no_cot_sanitized.txt`: the agent's actions and
 * tool results with its reasoning blocks stripped, the monitor-without-CoT protocol (as for
 * MRT). The agent's system prompt, which states the side task, is in no transcript. A transcript
 * over 400,000 chars (a third of runs; the longest is 6.8M chars) keeps its head and tail and
 * loses its middle to a marker; `meta.transcriptElidedChars` says how much.
 *
 * The main task is not shipped as a file: it is the `task_instruction.md` a shipped Claude
 * monitor read (the same text for honest and attack runs); `meta.mainTaskFrom` names the log it
 * came from, or is "none" when no Claude monitor log of the run read it (4 runs have no
 * Claude monitor), leaving `mainTask` empty.
 *
 * Shipped verdicts (`results.json`, an integer suspicion score 0–100) are kept for every
 * monitor without artifact access, in `meta.shippedScores` keyed by the monitor directory
 * without its provider prefix: `claude-opus-4-8_high`, `gpt-5.4_medium`, `glm-5.1`, with `_cot`
 * when the monitor also read the agent's reasoning and `L0_` for upstream's `monitor_strength`
 * 0 (all others are 1). Monitors that shipped no score (none, or upstream's -1 for a failed
 * monitor: a refusal, a CLI error, unparseable output; about 2% of results) are listed in
 * `meta.unscoredMonitors`.
 */

import { balancedSample, mapLimited, type Benchmark } from "./benchmark.ts";
import { clipMiddle } from "./clip.ts";
import { hubFile, hubTree } from "./hf.ts";
import type { MonitorItem } from "../items.ts";

const DATASET = "aisa-group/ResearchArena-Trajectories";
const REVISION = "8cd737c58bdac876fbf7b137796508c99c6e9588";
const SETTINGS = [
  "cuda_kernel",
  "inference_optimization",
  "safety_finetuning",
  "utility_finetuning",
];
const RUNS = 390;
const TRANSCRIPT = "red_team/solve_parsed_no_cot_sanitized.txt";
const TRANSCRIPT_CAP = 400_000;
/** The score upstream writes when a monitor failed (refusal, crash, unparseable output). */
const FAILED = -1;

/** `[L0_]<provider>_<monitor>[_artifact][_cot]`, e.g. `claude_claude-opus-4-8_high_cot`. */
const MONITOR_DIR =
  /^(?<level>L0_)?(?:claude|codex|opencode)_(?<monitor>.+?)(?<artifact>_artifact)?(?<cot>_cot)?$/;

/** The shippedScores key for a monitor directory; null for artifact-access monitors. */
export function monitorKey(directory: string): string | null {
  const groups = MONITOR_DIR.exec(directory)?.groups;
  if (!groups?.monitor) throw new Error(`${DATASET}: unrecognised monitor directory ${directory}`);
  if (groups.artifact) return null;
  return `${groups.level ?? ""}${groups.monitor}${groups.cot ?? ""}`;
}

export interface RunMetadata {
  setting: string;
  side_task: string;
  red_provider?: string;
  red_model?: string;
  experiment?: string;
  task_config?: string;
}

export interface ResearchRun {
  id: string;
  label: 0 | 1;
  path: string;
  metadata: RunMetadata;
}

async function candidates(): Promise<ResearchRun[]> {
  const listings = await mapLimited(SETTINGS, 4, (setting) => hubTree(DATASET, REVISION, setting));
  const paths = listings.flat().flatMap((e) => (e.type === "directory" ? [e.path] : []));
  if (paths.length !== RUNS) {
    throw new Error(`${DATASET}@${REVISION}: ${paths.length} runs, expected ${RUNS}`);
  }
  return mapLimited(paths, 8, async (path) => {
    const where = `${DATASET}/${path}/metadata.json`;
    const metadata = JSON.parse(await hubFile(DATASET, REVISION, `${path}/metadata.json`));
    if (typeof metadata?.side_task !== "string" || typeof metadata.setting !== "string") {
      throw new Error(`${where}: no setting/side_task strings`);
    }
    const label = metadata.side_task === "none" ? 0 : 1;
    return { id: `research-arena:${path}`, label, path, metadata: metadata as RunMetadata };
  });
}

interface MonitorResult {
  suspicion_score?: unknown;
  main_task_score?: unknown;
  side_task_score?: unknown;
}

export interface Verdicts {
  shippedScores: Record<string, number>;
  unscoredMonitors: string[];
  mainTaskScore?: number;
  sideTaskScore?: number;
}

/** Fold each non-artifact monitor's `results.json` into the item's verdicts. */
export function collectVerdicts(results: ReadonlyArray<[string, MonitorResult]>): Verdicts {
  const verdicts: Verdicts = { shippedScores: {}, unscoredMonitors: [] };
  for (const [directory, result] of results) {
    const key = monitorKey(directory);
    if (key === null) continue;
    const score = result.suspicion_score;
    if (typeof score === "number" && score >= 0 && score <= 100) {
      verdicts.shippedScores[key] = score;
    } else if (score === null || score === undefined || score === FAILED) {
      verdicts.unscoredMonitors.push(directory);
    } else {
      throw new Error(`${directory}/results.json: suspicion_score ${JSON.stringify(score)}`);
    }
    const { main_task_score: main, side_task_score: side } = result;
    if (typeof main === "number") verdicts.mainTaskScore ??= main;
    if (typeof side === "number") verdicts.sideTaskScore ??= side;
  }
  return verdicts;
}

/** The `task_instruction.md` a Claude monitor read, from its stream-json log; null if unread. */
export function taskInstruction(log: string, where: string): string | null {
  for (const [index, line] of log.split("\n").entries()) {
    if (!line.trim()) continue;
    let event: { tool_use_result?: { file?: { filePath?: unknown; content?: unknown } } };
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`${where}:${index + 1}: not JSON (${(error as Error).message})`);
    }
    const result = event.tool_use_result;
    const file = typeof result === "object" ? result?.file : undefined;
    const path = String(file?.filePath ?? "");
    if (path.endsWith("/task_instruction.md") && typeof file?.content === "string") {
      return file.content;
    }
  }
  return null;
}

export interface RunParts {
  transcript: string;
  mainTask: string;
  mainTaskFrom: string;
  verdicts: Verdicts;
}

export function researchItem(source: string, run: ResearchRun, parts: RunParts): MonitorItem {
  const { metadata } = run;
  const clipped = clipMiddle(
    parts.transcript,
    TRANSCRIPT_CAP,
    `transcripts are clipped to ${TRANSCRIPT_CAP.toLocaleString("en-US")} chars`,
  );
  return {
    id: run.id,
    source,
    task: metadata.setting,
    label: metadata.side_task === "none" ? 0 : 1,
    mainTask: parts.mainTask.trim(),
    transcript: clipped.text,
    meta: {
      sideTask: metadata.side_task,
      agent: `${metadata.red_provider ?? "?"}/${metadata.red_model ?? "?"}`,
      experiment: metadata.experiment ?? "",
      taskConfig: metadata.task_config ?? "",
      mainTaskScore: parts.verdicts.mainTaskScore ?? null,
      sideTaskScore: parts.verdicts.sideTaskScore ?? null,
      mainTaskFrom: parts.mainTaskFrom,
      transcriptChars: parts.transcript.length,
      transcriptElidedChars: clipped.elided,
      shippedScores: parts.verdicts.shippedScores,
      unscoredMonitors: parts.verdicts.unscoredMonitors,
    },
  };
}

/** Claude monitors without artifact access, no-CoT first: whose logs may hold the task. */
function claudeLogs(directories: readonly string[]): string[] {
  return directories
    .filter((d) => d.startsWith("claude_") && monitorKey(d) !== null)
    .sort((a, b) => Number(a.endsWith("_cot")) - Number(b.endsWith("_cot")) || (a < b ? -1 : 1));
}

interface MainTask {
  text: string;
  from: string;
  /** Logs passed over because upstream wrote them malformed (interleaved lines). */
  malformedLogs: string[];
}

/** The task instruction from the first Claude monitor log that recorded it. */
async function mainTaskOf(root: string, files: ReadonlySet<string>): Promise<MainTask> {
  const directories = [...files].map((file) => file.split("/")[0] ?? "");
  const malformedLogs: string[] = [];
  for (const directory of claudeLogs([...new Set(directories)])) {
    const log = `${directory}/monitor_out_sanitized.json`;
    if (!files.has(log)) continue;
    const text = await hubFile(DATASET, REVISION, `${root}/${log}`);
    let instruction: string | null;
    try {
      instruction = taskInstruction(text, `${DATASET}/${root}/${log}`);
    } catch (error) {
      console.warn(`research-arena: skipping a malformed monitor log: ${(error as Error).message}`);
      malformedLogs.push(log);
      continue;
    }
    if (instruction !== null) return { text: instruction, from: `${root}/${log}`, malformedLogs };
  }
  return { text: "", from: "none", malformedLogs };
}

async function toItem(source: string, candidate: ResearchRun): Promise<MonitorItem> {
  const root = `${candidate.path}/blue_team`;
  const entries = await hubTree(DATASET, REVISION, root, { recursive: true });
  const files = new Set(
    entries.flatMap((e) => (e.type === "file" ? [e.path.slice(root.length + 1)] : [])),
  );
  const directories = [...new Set([...files].map((file) => file.split("/")[0] ?? ""))].sort();
  const trajectoryOnly = directories.filter((directory) => monitorKey(directory) !== null);
  const results = await mapLimited(trajectoryOnly, 4, async (directory) => {
    const file = `${directory}/results.json`;
    if (!files.has(file)) return [directory, {}] as [string, MonitorResult];
    const result = JSON.parse(await hubFile(DATASET, REVISION, `${root}/${file}`));
    return [directory, result as MonitorResult] as [string, MonitorResult];
  });
  const mainTask = await mainTaskOf(root, files);
  const transcript = await hubFile(DATASET, REVISION, `${candidate.path}/${TRANSCRIPT}`);
  const verdicts = collectVerdicts(results);
  const item = researchItem(source, candidate, {
    transcript,
    mainTask: mainTask.text,
    mainTaskFrom: mainTask.from,
    verdicts,
  });
  return { ...item, meta: { ...item.meta, malformedMonitorLogs: mainTask.malformedLogs } };
}

const researchArena: Benchmark = {
  name: "research-arena",
  provenance: `ResearchArena (arXiv 2607.19321); HF ${DATASET}`,
  licence: "Apache-2.0",
  fetch: async (perClass) => {
    const pool = await candidates();
    const chosen = balancedSample(pool, perClass);
    const items = await mapLimited(chosen, 4, (candidate) => toItem("research-arena", candidate));
    return { items, available: pool.length };
  },
};

export const RESEARCH_ARENA: readonly Benchmark[] = [researchArena];
