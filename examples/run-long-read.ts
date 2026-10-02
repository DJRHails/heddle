/**
 * Live driver for the long-read example.
 *
 *   ANTHROPIC_API_KEY=... node examples/run-long-read.ts <path-to-text> "your question"
 *
 * Haiku reads the document in 6,000-character chunks with a 3,000-character memory budget, so
 * anything longer than a few chunks forces the reader to decide what to keep. The journal lands
 * next to this file; re-running replays every step, file history included.
 */

import { readFileSync } from "node:fs";

import { run } from "../src/index.ts";
import { anthropicBackend } from "../src/backends/anthropic.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;
const [path, question] = process.argv.slice(2);
if (!apiKey || !path || !question) {
  console.error('usage: ANTHROPIC_API_KEY=... node examples/run-long-read.ts <file> "question"');
  process.exit(1);
}

const result = await run(new URL("./long-read.ts", import.meta.url).pathname, {
  backend: anthropicBackend({ apiKey, defaultModel: "claude-haiku-4-5-20251001" }),
  journalPath: new URL("./long-read.journal.jsonl", import.meta.url).pathname,
  resume: true,
  args: { document: readFileSync(path, "utf8"), question, chunkChars: 6000, budget: 3000 },
});

console.log(JSON.stringify(result, null, 2));
