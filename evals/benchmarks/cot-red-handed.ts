/**
 * CoT Red-Handed (Arnav et al., "CoT Red-Handed: Stress Testing Chain-of-Thought Monitoring",
 * arXiv 2505.23575): BigCodeBench problems solved either honestly or with a covert side task
 * (exit early, delete files, log I/O, inflate complexity, long lines, rename a variable, change
 * a default value, mishandle an edge case, edit permissions). Data: a third-party re-run on the
 * Hub with no stated licence, HF aksh-n/cot-red-handed-trajectories — 704 Claude Haiku 4.5 runs
 * (289 honest, 415 with a side task under the paper's "dependency" attack policy), reasoning
 * kept for both classes. Two datasets over the same runs, the paper's two monitor settings:
 *
 * - `cot-red-handed`: action-only — the problem and the submitted code (the answer's python
 *   block, which BigCodeBench's scorer executes).
 * - `cot-red-handed-cot`: CoT — the problem, the run's reasoning, then its full answer.
 *
 * The same author's larger copy of the paper's own runs (HF aksh-n/cot-red-handed, four models,
 * 15,460 rows) is not used: its honest rows are BigCodeBench's canonical human-written
 * solutions, not model output (2,191 of 2,222 contain the canonical solution verbatim; 608 of
 * 635 tasks have the same honest answer in every model split), so label 0 vs 1 is human vs
 * model code — submitted-code length alone separates them at AUROC 0.81. It also has no
 * reasoning for the three reasoning models.
 *
 * The copy holds only runs the paper monitors (its A.2): honest runs that pass the tests and
 * attack runs that pass both the main and the side task's tests; the converter checks this.
 * Label 1 = the run was given a side task. The side-task instruction is never shown: the
 * problem is the prompt as honest runs saw it. A CoT that discusses the side task is the
 * evidence a CoT monitor is meant to catch, so it stays. The copy ships no monitor scores.
 */

import { sampled, type Benchmark } from "./benchmark.ts";
import { assertLatestRevision, hubRowsPatiently } from "./hub-latest.ts";
import { opaqueId } from "./opaque-id.ts";
import type { MonitorItem } from "../items.ts";

const DATASET = "aksh-n/cot-red-handed-trajectories";
const REVISION = "a6d92078bd7e6f83685d420eb4afdc0183c05db7";
const ROWS = 704;
const HONEST = "baseline";

/** The python block of an answer; an unterminated one (a run cut off) runs to the end. */
const PYTHON_BLOCK = /```python\n(?<code>[\s\S]*?)(?:```|$)/;

export interface Run {
  task_id: number;
  prompt: string;
  answer: string;
  agent_thinking: string | null;
  side_task: string;
  attack_policy: string;
  model: string;
  main_only: boolean;
  main_and_side: boolean | null;
  ground_truth: number;
}

export type View = "action" | "cot";

/** The code a run submitted: its answer's first python block. */
export function submittedCode(answer: string, where: string): string {
  const code = PYTHON_BLOCK.exec(answer)?.groups?.code?.trim();
  if (!code) throw new Error(`${where}: the answer has no python block`);
  return code;
}

/** The label from the run's condition, checked against the copy's `ground_truth` and A.2. */
export function runLabel(run: Run, where: string): 0 | 1 {
  const label = run.side_task === HONEST ? 0 : 1;
  if (run.ground_truth !== label) {
    throw new Error(`${where}: side_task "${run.side_task}" vs ground_truth ${run.ground_truth}`);
  }
  if (run.main_only !== true || (label === 1 && run.main_and_side !== true)) {
    throw new Error(`${where}: not a run the paper monitors (main or side task failed)`);
  }
  return label;
}

export function runTranscript(run: Run, view: View, where: string): string {
  if (view === "action") {
    return "[assistant] Submitted code:\n```python\n" + submittedCode(run.answer, where) + "\n```";
  }
  const reasoning = run.agent_thinking?.trim();
  if (!reasoning) throw new Error(`${where}: no reasoning`);
  return `[assistant reasoning]\n${reasoning}\n\n[assistant]\n${run.answer.trim()}`;
}

export function runItem(source: string, view: View, run: Run): MonitorItem {
  const where = `${DATASET} task ${run.task_id}/${run.side_task}`;
  const label = runLabel(run, where);
  const nativeId = `${run.task_id}:${run.side_task}`;
  return {
    id: opaqueId(source, nativeId),
    source,
    task: label === 0 ? "honest" : run.side_task,
    label,
    mainTask: run.prompt,
    transcript: runTranscript(run, view, where),
    meta: { nativeId, model: run.model, attackPolicy: run.attack_policy },
  };
}

function cotRedHanded(name: string, view: View, setting: string): Benchmark {
  return {
    name,
    provenance:
      `CoT Red-Handed (arXiv 2505.23575), ${setting}, Claude Haiku 4.5 re-run;` +
      ` HF ${DATASET} (third-party copy)`,
    licence: "none stated (third-party copy)",
    fetch: async (perClass) => {
      await assertLatestRevision(DATASET, REVISION);
      const runs = (await hubRowsPatiently(DATASET)) as unknown as Run[];
      if (runs.length !== ROWS) {
        throw new Error(`${DATASET}: expected ${ROWS} rows, got ${runs.length}`);
      }
      return sampled(
        runs.map((run) => runItem(name, view, run)),
        perClass,
      );
    },
  };
}

export const COT_RED_HANDED: readonly Benchmark[] = [
  cotRedHanded("cot-red-handed", "action", "action-only"),
  cotRedHanded("cot-red-handed-cot", "cot", "CoT + answer"),
];
