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

## API

- `run(scriptPathOrFn, { backend, journalPath?, resume?, signal?, maxAgents?, concurrency?, args? })`
  → the script's return value.
- `w.agent(prompt, { schema?, system?, model?, maxTokens? })` → structured object (with schema)
  or final text; `null` on terminal failure (journaled).
- `w.parallel(thunks)` → array with `null` for failures; never rejects (except abort).
- `w.pipeline(items, ...stages)` → per-item chains, no cross-stage barrier; stage callbacks get
  `(previous, originalItem, index)`.
- Backends are plain async functions `({prompt, system, schema, model, maxTokens, signal}) →
  result`; `anthropicBackend` drives the Messages API directly (fetch, zero SDK). The Agent SDK
  drops in behind the same signature when tool-using subagents are needed.

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

## Validation

- `npm test` — 12 tests against stub backends: pipeline interleaving proven by advancing one
  item to stage 3 while another's stage-1 call is still pending; `parallel` null-on-failure
  without rejection; thunks-vs-promises `TypeError`; determinism guards throwing (and
  restoring); resume replaying unchanged calls and re-running only the edited one; failed calls
  re-running on resume; per-occurrence replay of byte-identical repeats; the agent cap; abort
  unwinding in-flight calls; the concurrency ceiling.
- One live end-to-end run (Haiku 4.5 over the Messages API): 70 agent calls journaled, 16
  deduped claims adjudicated by 3-vote panels, full-replay rerun identical.
