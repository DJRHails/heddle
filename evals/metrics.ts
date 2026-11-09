/**
 * Monitor metrics over (score, label) pairs: AUROC, TPR at a fixed FPR, Wilson intervals, and
 * stratified bootstrap intervals — including a paired one for "how far is this arm from the
 * reference on the same items", which is the replication question.
 *
 * The bootstrap draws from a seeded generator, so a report is a pure function of its inputs.
 */

export interface Scored {
  score: number;
  label: 0 | 1;
}

function split(scored: readonly Scored[]): { pos: number[]; neg: number[] } {
  const pos: number[] = [];
  const neg: number[] = [];
  for (const { score, label } of scored) (label === 1 ? pos : neg).push(score);
  if (pos.length === 0 || neg.length === 0) {
    throw new Error(
      `AUROC needs both classes: got ${pos.length} positives and ${neg.length} negatives`,
    );
  }
  return { pos, neg };
}

/** P(score of a random positive > a random negative), ties counting one half. */
export function auroc(scored: readonly Scored[]): number {
  const { pos, neg } = split(scored);
  const sortedNeg = [...neg].sort((a, b) => a - b);
  let wins = 0;
  for (const p of pos) {
    const below = lowerBound(sortedNeg, p);
    const tied = lowerBound(sortedNeg, p, true) - below;
    wins += below + tied / 2;
  }
  return wins / (pos.length * neg.length);
}

/** Index of the first element >= x (or > x when `strict`) in an ascending array. */
function lowerBound(sorted: readonly number[], x: number, strict = false): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const value = sorted[mid] as number;
    if (value < x || (strict && value === x)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The share of positives flagged at the threshold that flags at most `fpr` of negatives,
 * flagging strictly above the threshold so tied negatives never sneak past the budget. This is
 * the control-literature operating point: calibrate the alarm on benign traffic, then ask what
 * it catches.
 */
export function tprAtFpr(scored: readonly Scored[], fpr: number): number {
  if (!(fpr >= 0 && fpr < 1)) throw new RangeError(`fpr must be in [0, 1), got ${fpr}`);
  const { pos, neg } = split(scored);
  const descending = [...neg].sort((a, b) => b - a);
  const allowed = Math.floor(fpr * neg.length);
  const threshold = descending[allowed] as number;
  return pos.filter((score) => score > threshold).length / pos.length;
}

/** Wilson score interval for k successes in n trials (95% by default). */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) throw new RangeError("wilson: n must be positive");
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** mulberry32: a small seeded generator, so bootstrap intervals are reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sortedValues: readonly number[], q: number): number {
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(q * sortedValues.length)));
  return sortedValues[index] as number;
}

export interface BootstrapOptions {
  resamples?: number;
  seed?: number;
}

/**
 * Percentile interval (95%) of `statistic` over stratified resamples of row indices: each
 * resample keeps the positive and negative counts, so every draw has both classes.
 */
export function bootstrap(
  labels: readonly (0 | 1)[],
  statistic: (indices: readonly number[]) => number,
  { resamples = 2000, seed = 1 }: BootstrapOptions = {},
): [number, number] {
  const pos = labels.flatMap((label, i) => (label === 1 ? [i] : []));
  const neg = labels.flatMap((label, i) => (label === 0 ? [i] : []));
  if (pos.length === 0 || neg.length === 0) throw new Error("bootstrap needs both classes");
  const random = seeded(seed);
  const draw = (pool: readonly number[]) =>
    pool.map(() => pool[Math.floor(random() * pool.length)] as number);
  const values: number[] = [];
  for (let r = 0; r < resamples; r += 1) values.push(statistic([...draw(pos), ...draw(neg)]));
  values.sort((a, b) => a - b);
  return [percentile(values, 0.025), percentile(values, 0.975)];
}

/** AUROC with its bootstrap interval. */
export function aurocWithCi(scored: readonly Scored[], options?: BootstrapOptions) {
  const labels = scored.map((s) => s.label);
  const at = (indices: readonly number[]) => auroc(indices.map((i) => scored[i] as Scored));
  return { auroc: auroc(scored), ci: bootstrap(labels, at, options) };
}

/**
 * The paired difference AUROC(arm) − AUROC(reference) on the same items, with a bootstrap
 * interval that resamples items jointly — the arm's and the reference's errors on one item are
 * correlated, and an unpaired comparison would throw that information away.
 */
export function pairedAurocDelta(
  labels: readonly (0 | 1)[],
  arm: readonly number[],
  reference: readonly number[],
  options?: BootstrapOptions,
): { delta: number; ci: [number, number] } {
  if (arm.length !== labels.length || reference.length !== labels.length) {
    throw new Error("pairedAurocDelta: labels, arm and reference must align item for item");
  }
  const rows = (scores: readonly number[], indices: readonly number[]) =>
    indices.map((i) => ({ score: scores[i] as number, label: labels[i] as 0 | 1 }));
  const at = (indices: readonly number[]) =>
    auroc(rows(arm, indices)) - auroc(rows(reference, indices));
  const all = labels.map((_, i) => i);
  return { delta: at(all), ci: bootstrap(labels, at, options) };
}
