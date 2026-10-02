/**
 * Context files: a leaf that manages its own context.
 *
 * An `agent()` call is stateless: everything it sees is assembled by the script. That is the
 * right default for control flow, but it makes every multi-step leaf run on a context policy a
 * human wrote: what to keep, what to summarise, when to drop. Context Language Models (Shao et
 * al. 2026, arXiv 2609.37725) measured the alternative: mirror the live context into a file the
 * model may rewrite without restriction (`c_{t+1} = f(c_t)`), and it beats harness-designed
 * compaction, summary and offloading policies on long-horizon tasks. A context file is that idea
 * at heddle's grain. The script still owns the control flow, and the model owns its own memory.
 *
 * - context(name, {task, system?, model?, maxTokens?, budget?, initial?}) -> a ContextFile. The
 *   task and system are pinned: they are re-sent on every step and are never part of the
 *   editable file, so no rewrite can corrupt the contract (the paper pins the system prompt and
 *   the initial task the same way). Names are unique per run, so many contexts can coexist (a
 *   swarm, or an orchestrator and its workers) and each is legible in the journal.
 * - file.step(observation, {schema?}) -> the model's reply, or null on terminal failure. The
 *   model sees the pinned task, its current file with a size readout against `budget`, and the
 *   observation. It answers in `reply` and may set `context`, which replaces the whole file:
 *   any function of the old file, unrestricted. When it does not, the observation and the reply
 *   are appended as two `[[CTX_TURN n role=…]]` turns (append is the default and an edit is the
 *   exception, as in the paper, so a quiet step costs no rewrite).
 * - file.text is the live file, readable by the script. An orchestrator can route on a
 *   worker's file, or hand it to another context as an observation.
 *
 * Steps on one file are sequential by construction: the next state is a function of the last,
 * so starting a step while one is in flight is a loud TypeError, like a promise passed to
 * `parallel`. A failed step leaves the file untouched: a dead call never corrupts the memory it
 * would have rewritten. Every step is one ordinary agent call through the shared scheduler,
 * keyed on the rendered prompt (the file's bytes included), so journal replay reproduces the
 * whole file history, and the journal records which context each call belonged to.
 *
 * The budget is a readout and not a gate, measured in characters so heddle carries no
 * tokenizer: a file over budget is still kept and the next step tells the model to compact it.
 * The backend's context window is the hard limit, and a step that overflows it fails to null
 * like any other call. An editable context is also a channel through which injected or
 * self-generated instructions persist across steps (the paper's safety note), which is one more
 * reason the task and system stay outside the editable file.
 */

import type {
  AgentOptions,
  ContextFile,
  ContextOptions,
  JsonSchema,
  StepOptions,
} from "./types.ts";

/** One agent call tagged with the context it belongs to; null on terminal failure. */
export type ContextCall = (
  prompt: string,
  opts: AgentOptions,
  context: string,
) => Promise<unknown>;

const TEXT_REPLY: JsonSchema = { type: "string" };

const MANAGE_YOUR_CONTEXT =
  "You manage your own context. The context file below is the only memory you carry from one" +
  " step to the next, and you may rewrite it however you like: keep what you will need, compact" +
  " or drop what you will not.";

const HOW_TO_REPLY =
  "Answer in `reply`. To rewrite your memory, set `context`: it replaces the whole context file" +
  " before your next step. Omit `context` to keep the file and append this step's observation" +
  " and reply to it as two new turns.";

function stepSchema(reply: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      reply,
      context: {
        type: "string",
        description: "Optional: the complete new context file, replacing the current one.",
      },
    },
    required: ["reply"],
    additionalProperties: false,
  };
}

function sizeReadout(chars: number, budget: number | undefined): string {
  if (budget === undefined) return `[context: ${chars} chars]`;
  const over = chars > budget ? " — OVER budget; compact the file this step" : "";
  return `[context: ${chars}/${budget} chars${over}]`;
}

interface StepView {
  name: string;
  task: string;
  text: string;
  budget: number | undefined;
  observation: string;
}

function renderStep({ name, task, text, budget, observation }: StepView): string {
  return [
    MANAGE_YOUR_CONTEXT,
    `<task>\n${task}\n</task>`,
    `<context_file name="${name}">\n${text}\n</context_file>`,
    sizeReadout(text.length, budget),
    `<observation>\n${observation}\n</observation>`,
    HOW_TO_REPLY,
  ].join("\n\n");
}

function replyText(reply: unknown): string {
  return typeof reply === "string" ? reply : JSON.stringify(reply);
}

function assertContextOptions(name: string, options: ContextOptions): void {
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError("context(name, options): name must be a non-empty string");
  }
  if (!options || typeof options.task !== "string" || !options.task.trim()) {
    throw new TypeError(`context(${name}): options.task must be a non-empty string`);
  }
  const { budget } = options;
  if (budget !== undefined && (!Number.isInteger(budget) || budget <= 0)) {
    throw new TypeError(`context(${name}): budget must be a positive integer, got ${budget}`);
  }
}

/** The step result's shape, checked: a backend that ignores the schema is a bug, not a null. */
function parseStep(name: string, result: unknown): { reply: unknown; context?: string } {
  const record = result as { reply?: unknown; context?: unknown } | null;
  if (!record || typeof record !== "object" || !("reply" in record)) {
    throw new TypeError(
      `context(${name}): the backend returned no {reply} object — got` +
        ` ${JSON.stringify(result).slice(0, 200)}; the backend must honour opts.schema`,
    );
  }
  if (record.context !== undefined && typeof record.context !== "string") {
    throw new TypeError(`context(${name}): the backend returned a non-string context`);
  }
  return { reply: record.reply, context: record.context };
}

export function makeContexts(
  call: ContextCall,
): (name: string, options: ContextOptions) => ContextFile {
  const names = new Set<string>();

  return function context(name: string, options: ContextOptions): ContextFile {
    assertContextOptions(name, options);
    if (names.has(name)) {
      throw new TypeError(
        `context(${name}): a context with this name already exists in this run — names key` +
          " the journal and the file history, so each must be unique",
      );
    }
    names.add(name);
    const { task, system, model, maxTokens, budget } = options;
    let text = options.initial ?? "";
    let turn = 0;
    let steps = 0;
    let stepping = false;

    async function step(observation: string, opts: StepOptions = {}): Promise<unknown> {
      if (typeof observation !== "string") {
        throw new TypeError(`context(${name}).step(observation): observation must be a string`);
      }
      if (stepping) {
        throw new TypeError(
          `context(${name}).step() called while a previous step is in flight — the next file` +
            " is a function of the last, so await each step before starting another",
        );
      }
      stepping = true;
      try {
        const prompt = renderStep({ name, task, text, budget, observation });
        const agentOpts: AgentOptions = {
          schema: stepSchema(opts.schema ?? TEXT_REPLY),
          system,
          model,
          maxTokens,
        };
        const result = await call(prompt, agentOpts, name);
        if (result === null) return null; // a dead step leaves the file untouched
        const { reply, context: rewrite } = parseStep(name, result);
        if (rewrite !== undefined) {
          text = rewrite;
        } else {
          const user = `[[CTX_TURN ${turn + 1} role=user]]\n${observation}`;
          const assistant = `[[CTX_TURN ${turn + 2} role=assistant]]\n${replyText(reply)}`;
          text = [text, user, assistant].filter(Boolean).join("\n");
          turn += 2;
        }
        steps += 1;
        return reply;
      } finally {
        stepping = false;
      }
    }

    return {
      name,
      get text() {
        return text;
      },
      get steps() {
        return steps;
      },
      step: step as ContextFile["step"],
    };
  };
}
