/**
 * Live driver for the inbox-triage example.
 *
 *   ANTHROPIC_API_KEY=... node examples/run-inbox.ts "the email text"
 *   ANTHROPIC_API_KEY=... JEV_API_KEY=... node examples/run-inbox.ts "the email text"
 *
 * With JEV_API_KEY set the decisions go to Jev and only the writing goes to Anthropic; without
 * it, Haiku plays judge too through structured output. The journal lands next to this file and
 * records which judge answered, so the two can be diffed on the same email. JEV_API_KEY lives
 * in the repo's glassine-encrypted .env.shared (`set -a; . ./.env.shared; set +a`).
 */

import { run } from "../src/index.ts";
import { anthropicBackend } from "../src/backends/anthropic.ts";
import { judge } from "../src/judges/jev.ts";
import { llmJudge } from "../src/judges/llm.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("set ANTHROPIC_API_KEY (and optionally JEV_API_KEY)");
  process.exit(1);
}

const email =
  process.argv[2] ??
  "Hi! Loved your talk last year. We're putting together a panel on agent orchestration for" +
    " our October meetup and would love to have you on it. Could you let us know if you'd be" +
    " interested? Cheers, Priya";

const backend = anthropicBackend({ apiKey, defaultModel: "claude-haiku-4-5-20251001" });
const jevApiKey = process.env.JEV_API_KEY;
const decider = jevApiKey
  ? judge({ apiKey: jevApiKey })
  : llmJudge(backend, { model: "claude-haiku-4-5-20251001" });

const result = await run(new URL("./inbox-triage.ts", import.meta.url).pathname, {
  backend,
  judge: decider,
  journalPath: new URL("./inbox-triage.journal.jsonl", import.meta.url).pathname,
  resume: true,
  args: { email },
});

console.log(JSON.stringify(result, null, 2));
