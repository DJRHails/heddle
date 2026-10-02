# heddle

Deterministic multi-agent orchestration: an ordinary TypeScript script fans out LLM subagents,
so all the control flow — loops, conditionals, fan-out, dedup, voting, kill thresholds — is
real code, and only the leaf calls are model-driven. A heddle is the loom part that lifts
selected warp threads so the shuttle can pass: the orchestrator decides which strands lift;
the model is the shuttle.

```ts
// script.ts — an ordinary ES module; no registry, no metadata block
import type { Workflow } from "heddle";

export default async function (w: Workflow<{ question: string }>) {
  const angles = await w.agent<{ angles: string[] }>("Decompose: …", { schema: ANGLES });
  const found = await w.parallel(angles.map((a) => () => w.agent<Claims>(`Search ${a}`, { schema: CLAIMS })));
  const deduped = dedupeInPlainCode(found.filter(Boolean));       // a barrier, because dedup needs everything
  return w.pipeline(deduped, deepRead, votePanel, tally);          // no barrier: items flow independently
}
```

```ts
import { run } from "heddle";
import { anthropicBackend } from "heddle/backends/anthropic";

const result = await run("./script.ts", {
  backend: anthropicBackend({ apiKey, defaultModel: "claude-haiku-4-5-20251001" }),
  journalPath: "./run.journal.jsonl",
  resume: true,
  args: { question },
});
```

The leaves that *write* are agents. The leaves that *decide* are judgments — a typed question
about a state, answered with probabilities, thresholded in code:

```ts
if (await w.feels(email, "needs a reply urgently", { confidence: 0.8 })) { … }   // true | false | null (unsure)
switch (await w.match(email, ["a bug report", "a feature request", "something else"])) { … }
while (await w.feels(draft, "full of corporate jargon", { confidence: 0.8 })) { draft = await rewrite(draft); }
```

## Design review (what this is, and what it deliberately is not)

This library exists because three specific properties were worth owning and nothing off the
shelf bundles them small:

1. **Journal + content-addressed resume.** One JSON line per settled agent call — the debugging
   surface and the resume mechanism are the same file. Re-running replays every call whose
   (prompt, semantic opts) is unchanged; editing a late stage re-runs only from the edit. This
   is what makes iterating on a harness affordable.
2. **Failure isolation with three-outcome discipline.** `agent()` resolves `null` on terminal
   failure and `parallel`/`pipeline` convert thrown stages to `null` — one dead agent never
   kills a fan-out. The corollary is enforced by convention and by the example: a `null` is
   **"no vote cast"**, never "refuted"; a tally has three outcomes (survived / refuted /
   could-not-adjudicate) and the report says which. Infrastructure failure must not read as a
   finding. Abort is the one exception: it propagates through everything, because an aborted
   run must unwind, not degrade into nulls.
3. **Schema-forced structured output with bounded retries.** `opts.schema` forces the model
   through a tool call whose `input_schema` is your JSON Schema; validation happens at the tool
   layer (ajv) and a mismatch retries the model with the errors appended, at most
   `MAX_SCHEMA_RETRIES` times. Without a schema the final text is the return value — and the
   backend's system prompt says so explicitly, or you get "Done." back instead of data.

**Don't-build-this was seriously considered.** LangGraph and Mastra are graph/step frameworks:
heavy dependency trees, their own control-flow abstractions — the opposite of "control flow is
plain code" — and neither has (prompt, opts)-keyed replay. Inngest is durable-execution server
infrastructure; its replay is sound but you adopt a service to get it. `p-limit` + async code +
the Agent SDK's subagents covers the *primitives* in an afternoon but gives you none of the
three properties above, and each is subtle enough to get wrong (see the null-vs-finding rule).
The verdict: build the ~600-line library, not a framework. One runtime dependency (ajv).

### Departures from the prior art (Claude Code's Workflow tool), and why

- **No sandbox at all, stated plainly.** The prior art runs scripts in `node:vm` — which is
  [not a security boundary](https://nodejs.org/api/vm.html) — so it bought no safety, and the
  bare realm broke real scripts (no `URL`, no structured clone). Here a script is an ordinary
  ES module: real stack traces, a debugger that works, the platform present. **The script
  author is trusted; that is a design assumption, not an oversight.** If untrusted scripts are
  ever in scope, the answer is a separate OS-sandboxed process (jailed subprocess, container) —
  not `node:vm`, not worker threads, not ShadowRealm, all of which share the process and its
  secrets.
- **No await-rewriting.** The prior art parses and rewrites the script (acorn) to wrap every
  `await` so abort/pause/budget can act at each suspension point. That machinery buys little:
  every suspension that costs money or time already passes through `agent()`, so abort
  (AbortSignal, raced against in-flight calls), the token/agent budget, and the concurrency cap
  are all enforced there — 30 lines instead of a compiler pass. What is lost: interrupting a
  script that busy-loops in pure JS without calling `agent()` (a wall-clock watchdog on the
  process covers it), and mid-run pause (kill + journal resume covers it).
- **Content-addressed replay instead of "longest unchanged prefix".** Under concurrency the
  *completion* order of agent calls varies run to run — network latency decides which pipeline
  chain advances first — so a prefix of the journal is not a well-defined replay unit. The set
  of calls a deterministic script makes *is* stable: replay keys on hash(prompt + semantic
  opts) plus an occurrence counter for byte-identical repeats. Unchanged calls replay wherever
  they fall in the interleaving; edited calls (and everything newly derived from their results)
  re-run. Failures are journaled but never replayed — a resume retries them.
- **Determinism guards are process-global with a platform exemption.** `Math.random()`,
  `Date.now()`, bare `Date()` and argless `new Date()` throw while a script runs (`new
  Date(x)` works; pass timestamps via `args`). The prior art could patch inside its realm; with
  real modules the patch is process-wide, and Node's own `fetch` calls `Date.now()` while
  draining a response body — from the same async context as the script, so no context-local
  flag can tell them apart. The guard exempts calls whose nearest stack frame is
  `node:internal`. A documented heuristic, not a boundary: a trusted script's *own* clock/random
  reads are what replay soundness depends on, and those throw.
- **Dropped by request:** no `phase()` / progress grouping, no script metadata block, no named
  workflow registry. A script is a file you point the runner at.

### Kept from the prior art, because it is right

- Three primitives only. `pipeline` is the default; a barrier (`parallel` then plain code) is
  correct only when a stage genuinely needs cross-item context — dedup across everything,
  early-exit on zero, "compare against the other findings".
- `parallel` takes thunks, not promises — a promise is already running and unthrottleable, and
  the mistake is silent, so passing one is a loud `TypeError`.
- Backstops: a concurrency cap from `availableParallelism()`, and a hard total-agent cap
  (default 1000) so a judgment-driven rewrite loop cannot run away.

## Decisions: `feels`, `match`, and the judge seam

Borrowed from [Probably](https://probably-lang.southpolesteve.workers.dev), a toy language over
[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev): `feels` asks a yes/no
question, `match` routes between descriptions, and its `while` keeps going until something
stops feeling true. Jev is the interesting part. It does not generate text; it answers typed
questions — **noul** (yes/no), **choice** (one of your labels), **score** (a rubric level) —
with calibrated probabilities, in one parallel pass, constrained to your options by
construction. That is exactly the shape of a decision leaf in an orchestration script: no
parsing, no schema retries, no hallucinated labels, and a probability you can threshold.

So a run has two model seams. `backend` writes (`agent`); `judge` decides (`judge`, `feels`,
`match`). Two judges ship:

- `judge({ apiKey, model? })` (`heddle/judges/jev`) — Jev over its HTTP API (`POST /v1/systemone`). Pin a versioned
  model id once you have tuned thresholds; the `jev-latest` alias moves.
- `llmJudge(backend, { model? })` — Jev's contract emulated by a text model through heddle's
  schema-forced structured output: one call per judgment, a JSON Schema that admits only a
  probability per option, distributions rescaled to sum to 1, argmax with first-label ties.
  **It is the default when no judge is given**, so every script runs on a text backend alone.
  Honest caveats: its probabilities are prompted estimates from a model not trained for
  calibration, and its `confidence` is simply the winner's probability where Jev derives its own
  statistic — thresholds tuned on one do not transfer to the other. Both judges journal under
  the same shape, so the same script can be diffed across them on one email.

Rules the primitives follow, and why:

- **Thresholds live in code, not in the question.** `feels(state, desc, {confidence: 0.8})`
  journals the judgment (p(yes)) and applies 0.8 afterwards. Changing a threshold therefore
  replays the journaled probability instead of re-judging — the sales-pitch run below did
  exactly that: the loop's gate was tightened and the resumed run re-used the 0.72 it had
  already recorded.
- **`null` from a decision means "unsure", never "failed".** `feels` returns `null` when the
  winning answer's probability is below the confidence threshold (Probably's `otherwise
  maybe`); `match` does the same under an optional gate. A judgment that cannot be obtained
  **throws** — a script cannot route on no decision, and spelling infrastructure failure the same
  way as "the model is unsure" would break the null-is-not-a-finding rule above. Inside
  `parallel`/`pipeline` the throw isolates to that item like any other.
- **Probably's `while` is not a primitive; it is a loop.** A script is TypeScript, so "rewrite
  until it stops feeling stiff" is `feels` in a loop condition, and the things a primitive would
  have to be opinionated about — the bound, whether hitting it throws or keeps the last draft,
  what a `null` rewrite means — stay the author's call, next to the code they affect:

  ```ts
  for (let pass = 0; pass < 5; pass += 1) {
    if (!(await w.feels(draft, "stiff or wordy", { confidence: 0.8 }))) break;
    const next = await w.agent(`Make this brief and natural:\n${draft}`);
    if (next === null) throw new Error("rewrite failed"); // a dead agent is not a finished draft
    draft = next;
  }
  ```

  Gate the condition so only a *confident* "still true" earns another pass: the first live run
  of the example spent five passes on a one-sentence decline the emulated judge kept rating
  ~70 % "stiff" while the rewrite converged to the same sentence.
- **No sampling mode (Probably's `chaos`).** It needs a random draw, which the determinism
  guards forbid for good reason; pass a seed through `args` and sample in plain code if you want
  it.
- Judgments share the scheduler with agents: the journal, the total-call cap (`maxAgents`
  counts both — a rewrite loop is precisely the loop that could run away), the concurrency ceiling,
  and the abort race.

## Context files: a leaf that manages its own memory

An `agent()` call is stateless, and that is the right default: the script assembles exactly
what each leaf sees. But a leaf that works across many steps (reading a long log, tracking
workers, iterating on its own drafts) then runs on a memory policy a human wrote into the
script: summarise at N tokens, keep the last k turns, drop tool output. [Context Language
Models](https://arxiv.org/abs/2609.37725) (Shao et al. 2026) measured the alternative. Mirror the
live context into a file the model may rewrite without restriction (`c_{t+1} = f(c_t)`), and it
beat harness-designed compaction, summary and offloading policies on long-horizon tasks (59.4%
vs ~53% for the best baseline on BrowseComp-Plus at 21.5% fewer FLOPs; one run per method).
`w.context` is that idea at heddle's grain: **the script keeps the control flow, and the model
keeps its own memory.**

```ts
const reader = w.context("reader", { task: `Read the log; at the end you will be asked: ${q}`, budget: 3000 });
for (const chunk of chunks) await reader.step(chunk);              // sequential: the next file is f(the last)
const verdict = await reader.step<Verdict>(`Answer: ${q}`, { schema: VERDICT });
reader.text;                                                       // the model's own memory, readable by code
```

- **Pinned contract, editable memory.** `task` and `system` are re-sent on every step and are
  never part of the file, so no rewrite can corrupt them. The paper pins the system prompt and
  the initial task the same way. An editable context is also a channel through which injected
  or self-generated instructions can persist across steps (the paper's own safety note), and
  keeping the contract out of the file is the cheap half of that defence.
- **Append by default, rewrite on demand.** Each step is forced through `{reply, context?}`.
  A `context` replaces the whole file, unrestricted. Without one, the observation and reply are
  appended as `[[CTX_TURN n role=…]]` turns, so a quiet step costs no retyping.
- **A counter, not a self-estimate.** Every step shows `[context: N/budget chars]` and flags a
  file over budget. Models misjudge their own context size, and the paper's steering results all
  rely on a readout like this. The budget is a readout and not a gate (characters, so heddle
  carries no tokenizer). The backend's window is the hard limit, and a step that overflows it
  fails to `null` like any other call.
- **The usual discipline holds.** A failed step resolves `null` and leaves the file untouched.
  Starting a step while one is in flight on the same file is a loud `TypeError`. Names are unique
  per run, so contexts coexist (an orchestrator can read a worker's `text` and hand it on as an
  observation). Each step is one agent call through the shared scheduler, keyed on the rendered
  prompt with the file's bytes included and journaled with the context's name, so resume
  replays the whole file history.

What this deliberately is not. In the paper's taxonomy a heddle script is a harness-scheduled
policy, the category it argues against, but its evidence comes from long single-agent loops
where the context is the bottleneck. It says nothing against deterministic control flow over
short schema-bound leaves, and its released harness itself wraps the model in deterministic
guardrails (budget nudges, an edit gate, a rollback ledger). So heddle hands the model its
*memory*, not the control flow. Model-decided spawning is not added either: the paper's
subagents added little on single-repo tasks (44.2 vs 44.6), and its one large multi-agent win
compared memory policies inside a fixed one-agent-per-repo swarm, which is `w.parallel` over
contexts. The edit primitive is a full rewrite rather than the paper's code-over-the-file,
because a leaf here has no sandbox to run code in. A rewrite costs output tokens in proportion
to the file, which the budget keeps small.

## API

Everything is typed: a script takes `Workflow<Args>` and the types below are exported from
`heddle`. The runtime checks stay, because a script may still be plain JavaScript — Node 22.18+
strips types natively, so `node script.ts` needs no build step, and the package ships `dist/`
(built by `tsc`, with declarations) for consumers.

- `run(scriptPathOrFn, { backend, judge?, journalPath?, resume?, signal?, maxAgents?, concurrency?, args? })`
  → the script's return value (typed when given the function; `unknown` from a path). `judge`
  defaults to `llmJudge(backend)`.
- `w.agent(prompt, { system?, model?, maxTokens? })` → the final text, or `null` on terminal
  failure (journaled). `w.agent<T>(prompt, { schema, … })` → `T | null`: the schema guarantees
  the shape and `T` names it.
- `w.parallel(thunks)` → array with `null` for failures; never rejects (except abort).
- `w.pipeline(items, ...stages)` → per-item chains, no cross-stage barrier; stage callbacks get
  `(previous, originalItem, index)`, with `previous` typed from the stage before (up to four
  stages; beyond that it is `unknown`).
- `w.feels(state, description, { confidence? = 0.5 })` → `true | false | null` (unsure).
- `w.match(state, labels | { label: description }, { confidence? = 0 })` → the winning label
  (typed as the union of the labels you passed), or `null` under the gate. Route on it with a
  plain `switch`.
- `w.judge(state, question)` → the raw Jev-shaped answer for one `Question` (`{type: "noul" |
  "choice" | "score", instructions, criteria}`) — the leaf the two above are built on, and the
  way to a `score` (`{score, legend, probabilities, confidence}`). The answer type follows the
  question type (`AnswerFor<Q>`).
- `w.context(name, { task, system?, model?, maxTokens?, budget?, initial? })` → a
  `ContextFile` the model manages itself. `file.step(observation)` → the reply text, or `null`
  on terminal failure (file untouched). `file.step<T>(observation, { schema })` → `T | null`.
  `file.text` is the live file and `file.steps` counts settled steps.
- Backends (`Backend`) are plain async functions `({prompt, system, schema, model, maxTokens,
  signal}) → result`; `anthropicBackend` drives the Messages API directly (fetch, zero SDK).
  The Agent SDK drops in behind the same signature when tool-using subagents are needed.
- Judges (`Judge`) are plain async functions `({state, questions, signal}) → {answers}` in
  Jev's request and answer shapes, with a `.model` property that enters the journal key:
  Jev's `judge` and the emulated `llmJudge` (`heddle/judges/jev`, `heddle/judges/llm`).

## Worked example

[`examples/adversarial-review.ts`](examples/adversarial-review.ts) — decompose a question into
angles, fan out searchers, **dedup claims in plain code** (the one legitimate barrier),
deep-read each survivor, run a 3-vote refutation panel per claim, tally with three outcomes,
synthesize only what survived. Run it live (Node 22.18+ runs the `.ts` directly):

```sh
ANTHROPIC_API_KEY=... node examples/run-live.ts "your research question"
```

The journal lands next to the example; re-running replays it (verified: a second run makes zero
new calls and returns byte-identical output).

[`examples/inbox-triage.ts`](examples/inbox-triage.ts) — Probably's inbox department, ported:
`feels` triages urgency and may say "unsure", `match` routes the email to one of four drafting
prompts, a loop over `feels` rewrites until the draft stops feeling stiff, a gated `feels` signs off or
revises once more, and the subject is written from the finished reply. It drafts; it sends
nothing.

```sh
ANTHROPIC_API_KEY=... node examples/run-inbox.ts "the email text"          # Haiku judges too
ANTHROPIC_API_KEY=... JEV_API_KEY=... node examples/run-inbox.ts "…"        # Jev judges
```

[`examples/long-read.ts`](examples/long-read.ts) — a reader that manages its own memory: the
script chunks a long document and steps a context file through it under a 3,000-character
budget, then asks the question. No summarisation threshold, note template or eviction rule
appears in the script.

```sh
ANTHROPIC_API_KEY=... node examples/run-long-read.ts paper.txt "your question"
```

`JEV_API_KEY` is kept in `.env.shared`, encrypted at rest by glassine (a sops-backed git
filter; recipients in `.sops.yaml`). Once `glassine init` has decrypted it for your key,
`set -a; . ./.env.shared; set +a` loads it.

## Validation

- `npm run check` — `tsc --noEmit` over `src`, `test` and `examples` (strict, with
  `noUncheckedIndexedAccess` and `erasableSyntaxOnly`, so every file also runs under Node's
  type stripping), `oxlint`, then the tests. `npm run build` emits `dist/` with declarations.
- `npm test` — 37 tests against stub backends and judges. Primitives: pipeline interleaving
  proven by advancing one item to stage 3 while another's stage-1 call is still pending;
  `parallel` null-on-failure without rejection; thunks-vs-promises `TypeError`; determinism
  guards throwing (and restoring); resume replaying unchanged calls and re-running only the
  edited one; failed calls re-running on resume; per-occurrence replay of byte-identical
  repeats; the call cap; abort unwinding in-flight calls; the concurrency ceiling. Decisions:
  `feels` three-way under a threshold and tie-is-yes; `match` from labels and from
  descriptions, gated to null, refusing one label; judgments journaled as `kind: "judge"`,
  replayed on resume, re-judged under a different judge model, counted against the cap; the
  default judge emulated over the backend. Judges: `llmJudge` building one schema per request,
  deriving Jev-shaped answers (argmax, expected-value score, legend), rescaling, first-label
  ties, rejecting zero mass and prose; Jev's `judge` posting the documented request shape with a
  bearer token, retrying 529, failing 422 loudly (mocked fetch). Context files: append by
  default and rewrite on demand, the pinned task and system riding every step outside the file,
  the caller's schema wrapped under `reply`, the size readout and its over-budget flag, a failed
  step leaving the file untouched, an in-flight step refused, duplicate names, empty tasks and
  bad budgets refused, a schema-ignoring backend failing loudly, steps journaled with their
  context name and the file history replayed on resume, and two coexisting contexts with one
  file handed to the other.
- Live run of the long read (Haiku 4.5, the CLM paper's 101k-character text in 17 chunks under
  a 3,000-character budget, asked about a definition from chunk 5): answered correctly, citing
  equation 6 after twelve more chunks. 13 of 18 steps rewrote the file. The rest appended a
  chunk, which put the file over budget, and the model compacted it on the next step. The
  memory peaked at 7,811 characters and went into the answer step at 5,759. Replay rerun
  byte-identical with zero new calls.
- Live runs of the adversarial review (Haiku 4.5 over the Messages API): 70 agent calls
  journaled, 16 deduped claims adjudicated by 3-vote panels, full-replay rerun identical.
- Live runs of the inbox triage with Haiku as both writer and emulated judge: an invitation
  routed at 0.95, urgency "unsure" (p(yes) 0.25 under a 0.8 gate), 6 calls journaled, replay
  rerun byte-identical with zero new calls; a sales pitch routed correctly, then spent the
  rewrite loop's five passes on a one-sentence decline (judge ~0.72 "stiff" every pass), and
  after gating the loop at 0.8 the resumed run replayed the recorded judgments and finished
  with 2 new calls.
- Live runs of the same two emails with **Jev deciding** (`jev-latest`, served as `jev-1.13.0`)
  and Haiku writing, on the same journal: the routes agreed with the emulation, so every agent
  call replayed and each run cost 4 judgments and about 2 s. Jev was sharper than the
  emulation: urgency p(yes) 0.18 and 0.14 (a confident "normal" where Haiku's 0.25 was
  "unsure" under the 0.8 gate), routing at 1.00 and 0.99, the one-sentence decline 0.62
  "stiff" (Haiku 0.72 — both under the gate, so neither rewrites), and 0.76 "polite and clear
  about the next step", which the gate reports as "unsure" — a fair verdict on a flat decline.
  Replay rerun byte-identical, zero new calls.
- The TypeScript port is journal-compatible: run from `.ts` source under Node's type stripping,
  the inbox example replayed all 29 calls the JavaScript version had journaled (Haiku and Jev
  runs alike) with zero new calls, and a fresh scheduling email then ran live end to end.
