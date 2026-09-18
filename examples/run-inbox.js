/**
 * Live driver for the inbox-triage example.
 *
 *   ANTHROPIC_API_KEY=... node examples/run-inbox.js "the email text"
 *   ANTHROPIC_API_KEY=... JEV_API_KEY=... node examples/run-inbox.js "the email text"
 *
 * With JEV_API_KEY set the decisions go to Jev and only the writing goes to Anthropic; without
 * it, Haiku plays judge too through structured output. The journal lands next to this file and
 * records which judge answered, so the two can be diffed on the same email.
 */

import { run } from "../src/index.js";
import { anthropicBackend } from "../src/backends/anthropic.js";
import { jevJudge } from "../src/judges/jev.js";
import { llmJudge } from "../src/judges/llm.js";

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
const judge = process.env.JEV_API_KEY
  ? jevJudge({ apiKey: process.env.JEV_API_KEY })
  : llmJudge(backend, { model: "claude-haiku-4-5-20251001" });

const result = await run(new URL("./inbox-triage.js", import.meta.url).pathname, {
  backend,
  judge,
  journalPath: new URL("./inbox-triage.journal.jsonl", import.meta.url).pathname,
  resume: true,
  args: { email },
});

console.log(JSON.stringify(result, null, 2));
