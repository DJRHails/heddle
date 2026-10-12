/**
 * Pinning and patient paging for converters that read through the datasets-server rows API,
 * which serves a dataset's latest revision only. `assertLatestRevision` checks the Hub's
 * current sha against the converter's pin, so a moved dataset fails loudly instead of being
 * converted under a stale pin. The API rate-limits bursts for a minute or more — longer than
 * `get`'s retries cover — so pages here wait out a 429 before giving up; `hubRowAt` reads one
 * row, for converters that sample rows before downloading (some full scans are ~700 MB).
 */

import { get } from "./hf.ts";

const HUB_API = "https://huggingface.co/api/datasets";
const ROWS_API = "https://datasets-server.huggingface.co/rows";
const PAGE = 100;
const RATE_LIMIT_WAITS_MS = [15_000, 30_000, 60_000, 120_000];

/** Throw unless `dataset`'s main branch is still at `revision`. */
export async function assertLatestRevision(dataset: string, revision: string): Promise<void> {
  const info = (await (await get(`${HUB_API}/${dataset}`)).json()) as { sha?: unknown };
  if (info.sha !== revision) {
    throw new Error(
      `${dataset}: the rows API serves the latest revision (${String(info.sha)}), but the` +
        ` converter is pinned to ${revision}; re-verify the converter against the new revision` +
        " and update the pin",
    );
  }
}

interface RowPage {
  rows: Array<{ row_idx: number; row: Record<string, unknown>; truncated_cells?: string[] }>;
  num_rows_total: number;
}

interface Split {
  config?: string;
  split?: string;
}

/** One page; a 429 is waited out, anything else goes to `get` (its retries, its error). */
async function rowsPage(
  dataset: string,
  { config = "default", split = "train" }: Split,
  offset: number,
  length: number,
): Promise<RowPage> {
  const query = new URLSearchParams({
    dataset,
    config,
    split,
    offset: String(offset),
    length: String(length),
  });
  const url = `${ROWS_API}?${query}`;
  for (const wait of RATE_LIMIT_WAITS_MS) {
    const response = await fetch(url);
    if (response.ok) return (await response.json()) as RowPage;
    if (response.status !== 429) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, wait));
  }
  return (await (await get(url)).json()) as RowPage;
}

function untruncated(dataset: string, entry: RowPage["rows"][number]): Record<string, unknown> {
  if (entry.truncated_cells && entry.truncated_cells.length > 0) {
    throw new Error(
      `${dataset} row ${entry.row_idx}: cells ${entry.truncated_cells.join(", ")} truncated` +
        " by the rows API",
    );
  }
  return entry.row;
}

/** Every row of one config/split; a truncated cell is an error, as in `hubRows`. */
export async function hubRowsPatiently(
  dataset: string,
  where: Split = {},
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await rowsPage(dataset, where, offset, PAGE);
    rows.push(...page.rows.map((entry) => untruncated(dataset, entry)));
    if (page.rows.length === 0 || offset + PAGE >= page.num_rows_total) return rows;
  }
}

/** Row `index` of one config/split, and the split's total row count. */
export async function hubRowAt(
  dataset: string,
  index: number,
  where: Split = {},
): Promise<{ row: Record<string, unknown>; total: number }> {
  const page = await rowsPage(dataset, where, index, 1);
  const [entry] = page.rows;
  if (entry?.row_idx !== index) {
    throw new Error(`${dataset} row ${index}: the rows API returned no such row`);
  }
  return { row: untruncated(dataset, entry), total: page.num_rows_total };
}
