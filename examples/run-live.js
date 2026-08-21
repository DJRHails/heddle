/**
 * Live end-to-end driver for the adversarial-review example.
 *
 *   ANTHROPIC_API_KEY=... node examples/run-live.js "your research question"
 *
 * The journal lands next to this file; re-running with the same question replays every cached
 * call, and editing a late stage in the example re-runs only from the edit.
 */

import { run } from "../src/index.js";
import { anthropicBackend } from "../src/backends/anthropic.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("set ANTHROPIC_API_KEY");
  process.exit(1);
}

const question =
  process.argv[2] ??
  "What actually limits TCP throughput on high-latency satellite links, and what mitigations are known to work?";

const result = await run(new URL("./adversarial-review.js", import.meta.url).pathname, {
  backend: anthropicBackend({ apiKey, defaultModel: "claude-haiku-4-5-20251001" }),
  journalPath: new URL("./adversarial-review.journal.jsonl", import.meta.url).pathname,
  resume: true,
  args: { question },
});

console.log(JSON.stringify(result, null, 2));
