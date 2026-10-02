/**
 * A reader that manages its own memory: walk a long document in chunks under a small context
 * budget, then answer a question from what the reader chose to keep.
 *
 * The control flow is the script's: chunk the text, step through the chunks in order, ask the
 * question at the end. What the reader remembers is the model's: each step it either lets the
 * chunk append to its context file or rewrites the file outright, with the budget shown back
 * on every step. No summarisation threshold, note template, or eviction rule is written here.
 * The script reads the file at the end to report how the memory evolved.
 *
 * Run:  node examples/run-long-read.ts <path-to-text> "your question"
 */

import type { Workflow } from "../src/index.ts";

export interface LongReadArgs {
  document: string;
  question: string;
  chunkChars: number;
  budget: number;
}

const ANSWER = {
  type: "object",
  properties: {
    answer: { type: "string" },
    evidence: { type: "string", description: "What in your memory supports the answer." },
  },
  required: ["answer", "evidence"],
  additionalProperties: false,
};

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let start = 0; start < text.length; start += size) {
    out.push(text.slice(start, start + size));
  }
  return out;
}

export default async function longRead(w: Workflow<LongReadArgs>) {
  const { document, question, chunkChars, budget } = w.args;
  const reader = w.context("reader", {
    task:
      `You are reading a long document one chunk at a time. At the end you will be asked:` +
      ` "${question}". Only your context file survives between chunks.`,
    budget,
  });
  const sizes: number[] = [];
  let failed = 0;
  for (const [index, chunk] of chunks(document, chunkChars).entries()) {
    const reply = await reader.step(`Chunk ${index + 1}:\n${chunk}`);
    if (reply === null) failed += 1; // a dead step keeps the memory it had; count it, go on
    sizes.push(reader.text.length);
  }
  const answer = await reader.step<{ answer: string; evidence: string }>(
    `The document is finished. Answer the question: ${question}`,
    { schema: ANSWER },
  );
  return { answer, failedSteps: failed, memorySizes: sizes, finalMemory: reader.text };
}
