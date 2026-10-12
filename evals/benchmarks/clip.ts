/**
 * Clipping for text too long to monitor whole. The head and tail stay and the middle goes,
 * replaced by a marker stating how much was cut and the rule that cut it, so neither a monitor
 * nor a reader can mistake a clipped transcript for a complete one.
 */

export interface Clipped {
  text: string;
  /** Characters removed (0 when the text fit). */
  elided: number;
}

/** At most `cap` characters of `text` (plus the marker), keeping its head and tail. */
export function clipMiddle(text: string, cap: number, rule: string): Clipped {
  if (text.length <= cap) return { text, elided: 0 };
  const head = Math.ceil(cap / 2);
  const tail = cap - head;
  const elided = text.length - cap;
  const marker = `\n[... ${elided.toLocaleString("en-US")} chars elided: ${rule} ...]\n`;
  return { text: text.slice(0, head) + marker + text.slice(text.length - tail), elided };
}
