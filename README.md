# heddle

Deterministic multi-agent orchestration: an ordinary JavaScript script fans out LLM subagents,
so all the control flow — loops, conditionals, fan-out, dedup, voting, kill thresholds — is
real code, and only the leaf calls are model-driven. A heddle is the loom part that lifts
selected warp threads so the shuttle can pass: the orchestrator decides which strands lift;
the model is the shuttle.

```js
// script.js — an ordinary ES module; no registry, no metadata block
export default async function (w) {
  const angles = await w.agent("Decompose: …", { schema: ANGLES });
  const found = await w.parallel(angles.map((a) => () => w.agent(`Search ${a}`, { schema: CLAIMS })));
  const deduped = dedupeInPlainCode(found.filter(Boolean));       // a barrier, because dedup needs everything
  return w.pipeline(deduped, deepRead, votePanel, tally);          // no barrier: items flow independently
}
```

```js
import { run } from "heddle";
import { anthropicBackend } from "heddle/backends/anthropic";

const result = await run("./script.js", {
  backend: anthropicBackend({ apiKey, defaultModel: "claude-haiku-4-5-20251001" }),
  journalPath: "./run.journal.jsonl",
  resume: true,
  args: { question },
});
```

The leaves that *write* are agents. The leaves that *decide* are judgments — a typed question
about a state, answered with probabilities, thresholded in code:

```js
if (await w.feels(email, "needs a reply urgently", { confidence: 0.8 })) { … }   // true | false | null (unsure)
switch (await w.match(email, ["a bug report", "a feature request", "something else"])) { … }
draft = await w.while(draft, "full of corporate jargon", (d) => w.agent(`Rewrite plainly:\n${d}`));
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
  (default 1000) so a budget-driven `while` loop cannot run away.

## Decisions: `feels`, `match`, `while`, and the judge seam

Borrowed from [Probably](https://probably-lang.southpolesteve.workers.dev), a toy language over
[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev): `feels` asks a yes/no
question, `match` routes between descriptions, `while` keeps going until something stops
feeling true. Jev is the interesting part. It does not generate text; it answers typed
questions — **noul** (yes/no), **choice** (one of your labels), **score** (a rubric level) —
with calibrated probabilities, in one parallel pass, constrained to your options by
construction. That is exactly the shape of a decision leaf in an orchestration script: no
parsing, no schema retries, no hallucinated labels, and a probability you can threshold.

So a run has two model seams. `backend` writes (`agent`); `judge` decides (`judge`, `feels`,
`match`, `while`). Two judges ship:

- `jevJudge({ apiKey, model? })` — Jev over its HTTP API (`POST /v1/systemone`). Pin a versioned
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
- **`while` is bounded and re-judges before every iteration, including after the last
  rewrite.** Still true after `maxIterations` (default 5) → it throws, naming the description.
  A step that returns `null` (a dead agent) throws too: a failed rewrite must not read as a
  finished one. Pass `{confidence}` so only a *confident* "still true" earns another pass; the
  first live run of the example spent all five iterations on a one-sentence decline the
  emulated judge kept rating ~70 % "stiff" while the rewrite converged to the same sentence.
- **No sampling mode (Probably's `chaos`).** It needs a random draw, which the determinism
  guards forbid for good reason; pass a seed through `args` and sample in plain code if you want
  it.
- Judgments share the scheduler with agents: the journal, the total-call cap (`maxAgents`
  counts both — a `while` is precisely the loop that could run away), the concurrency ceiling,
  and the abort race.

## API

- `run(scriptPathOrFn, { backend, judge?, journalPath?, resume?, signal?, maxAgents?, concurrency?, args? })`
  → the script's return value. `judge` defaults to `llmJudge(backend)`.
- `w.agent(prompt, { schema?, system?, model?, maxTokens? })` → structured object (with schema)
  or final text; `null` on terminal failure (journaled).
- `w.parallel(thunks)` → array with `null` for failures; never rejects (except abort).
- `w.pipeline(items, ...stages)` → per-item chains, no cross-stage barrier; stage callbacks get
  `(previous, originalItem, index)`.
- `w.feels(state, description, { confidence? = 0.5 })` → `true | false | null` (unsure).
- `w.match(state, labels | { label: description }, { confidence? = 0 })` → the winning label,
  or `null` under the gate. Route on it with a plain `switch`.
- `w.while(value, description, step, { maxIterations? = 5, confidence? })` → the first value
  for which the description stops feeling true; `step(current, i)` produces the next value.
- `w.judge(state, question)` → the raw Jev-shaped answer for one `{type: "noul" | "choice" |
  "score", instructions, criteria}` question — the leaf the three above are built on, and the
  way to a `score` (`{score, legend, probabilities, confidence}`).
- Backends are plain async functions `({prompt, system, schema, model, maxTokens, signal}) →
  result`; `anthropicBackend` drives the Messages API directly (fetch, zero SDK). The Agent SDK
  drops in behind the same signature when tool-using subagents are needed.
- Judges are plain async functions `({state, questions, signal}) → {answers}` in Jev's request
  and answer shapes, with a `.model` property that enters the journal key: `jevJudge` and
  `llmJudge` (`heddle/judges/jev`, `heddle/judges/llm`).

## Worked example

[`examples/adversarial-review.js`](examples/adversarial-review.js) — decompose a question into
angles, fan out searchers, **dedup claims in plain code** (the one legitimate barrier),
deep-read each survivor, run a 3-vote refutation panel per claim, tally with three outcomes,
synthesize only what survived. Run it live:

```sh
ANTHROPIC_API_KEY=... node examples/run-live.js "your research question"
```

The journal lands next to the example; re-running replays it (verified: a second run makes zero
new calls and returns byte-identical output).

[`examples/inbox-triage.js`](examples/inbox-triage.js) — Probably's inbox department, ported:
`feels` triages urgency and may say "unsure", `match` routes the email to one of four drafting
prompts, `while` rewrites until the draft stops feeling stiff, a gated `feels` signs off or
revises once more, and the subject is written from the finished reply. It drafts; it sends
nothing.

```sh
ANTHROPIC_API_KEY=... node examples/run-inbox.js "the email text"          # Haiku judges too
ANTHROPIC_API_KEY=... JEV_API_KEY=... node examples/run-inbox.js "…"        # Jev judges
```

## Validation

- `npm test` — 30 tests against stub backends and judges. Primitives: pipeline interleaving
  proven by advancing one item to stage 3 while another's stage-1 call is still pending;
  `parallel` null-on-failure without rejection; thunks-vs-promises `TypeError`; determinism
  guards throwing (and restoring); resume replaying unchanged calls and re-running only the
  edited one; failed calls re-running on resume; per-occurrence replay of byte-identical
  repeats; the call cap; abort unwinding in-flight calls; the concurrency ceiling. Decisions:
  `feels` three-way under a threshold and tie-is-yes; `match` from labels and from
  descriptions, gated to null, refusing one label; `while` re-judging before every iteration,
  throwing after `maxIterations` and on a null step; judgments journaled as `kind: "judge"`,
  replayed on resume, re-judged under a different judge model, counted against the cap; the
  default judge emulated over the backend. Judges: `llmJudge` building one schema per request,
  deriving Jev-shaped answers (argmax, expected-value score, legend), rescaling, first-label
  ties, rejecting zero mass and prose; `jevJudge` posting the documented request shape with a
  bearer token, retrying 529, failing 422 loudly (mocked fetch — no Jev key was available).
- Live runs of the adversarial review (Haiku 4.5 over the Messages API): 70 agent calls
  journaled, 16 deduped claims adjudicated by 3-vote panels, full-replay rerun identical.
- Live runs of the inbox triage with Haiku as both writer and emulated judge: an invitation
  routed at 0.95, urgency "unsure" (p(yes) 0.25 under a 0.8 gate), 6 calls journaled, replay
  rerun byte-identical with zero new calls; a sales pitch routed correctly, then hit the
  `while` 5-iteration backstop (judge ~0.72 "stiff" on a one-sentence decline), and after gating
  the loop at 0.8 the resumed run replayed the recorded judgments and finished with 2 new calls.
