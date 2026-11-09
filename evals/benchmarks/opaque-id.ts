/**
 * Item ids that say nothing about the label. Some monitor arms show the id to the model (the
 * long-read arm names its context file after it), and native ids often encode the condition:
 * a response's position in a benign/misbehaving pair, a `clean`/`backdoor` role, a side-task
 * name, label-sorted numbering. Converters hash such ids and keep the native one in
 * `meta.nativeId` for tracing back upstream.
 */

import { createHash } from "node:crypto";

export function opaqueId(source: string, native: string): string {
  const digest = createHash("sha256").update(`${source}:${native}`).digest("hex");
  return `${source}:${digest.slice(0, 16)}`;
}
