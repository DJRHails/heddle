/**
 * Fetching from the Hugging Face Hub with no dependency: raw files at a pinned revision
 * (`resolve/<sha>/<path>`, so a converted dataset is reproducible byte for byte), and the
 * datasets-server rows API for parquet-only public datasets. Every dataset converted here is
 * public, so no token is sent. Every failure names the URL and the status.
 */

const HUB = "https://huggingface.co";
const ROWS_API = "https://datasets-server.huggingface.co/rows";
const PAGE = 100;

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const ATTEMPTS = 4;
/** The longest `Retry-After` waited out; a longer one fails the fetch with the server's reply. */
const MAX_RETRY_AFTER_S = 300;

/** The Hub's `RateLimit: "<bucket>";r=<remaining>;t=<seconds to reset>` header. */
const RATE_LIMIT_RESET = /;\s*t=(?<seconds>\d+)/;

/**
 * How long to wait before the next attempt: the server's `Retry-After`, else the reset its
 * `RateLimit` header names, else exponential backoff.
 */
function backoffMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after") ?? NaN);
  const rateLimit = RATE_LIMIT_RESET.exec(response.headers.get("ratelimit") ?? "");
  const reset = Number(rateLimit?.groups?.seconds ?? NaN);
  for (const seconds of [retryAfter, reset]) {
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_RETRY_AFTER_S) {
      return seconds * 1000 + 1000;
    }
  }
  return 1000 * 2 ** attempt;
}

/**
 * GET with bounded retries on transient statuses (the Hub's LFS redirects 502 now and then, and
 * its rate limits answer 429 with a `Retry-After`); anything else, or the last transient
 * failure, throws with the URL and status.
 */
export async function get(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return response;
    const detail = (await response.text()).slice(0, 300);
    if (TRANSIENT.has(response.status) && attempt < ATTEMPTS) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, backoffMs(response, attempt)));
      continue;
    }
    const hint = response.status === 401 || response.status === 403 ? " (gated dataset?)" : "";
    throw new Error(`GET ${url} -> ${response.status}${hint}: ${detail}`);
  }
}

/** A file from a dataset repo at a pinned revision, as text. */
export async function hubFile(dataset: string, revision: string, path: string): Promise<string> {
  const url = `${HUB}/datasets/${dataset}/resolve/${revision}/${path}`;
  return (await get(url)).text();
}

/** Parse JSONL text; a bad line names its source and line number. */
export function parseJsonl(text: string, source: string): unknown[] {
  return text.split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch (error) {
      throw new Error(`${source}:${index + 1}: not JSON (${(error as Error).message})`);
    }
  });
}

interface RowsPage {
  rows: Array<{ row_idx: number; row: Record<string, unknown>; truncated_cells?: string[] }>;
  num_rows_total: number;
}

/**
 * Every row of one config/split through the datasets-server rows API. It serves the latest
 * revision only, so converters using it record the row count they expect and fail on drift.
 * A truncated cell is an error: a clipped transcript would silently change what is monitored.
 */
export async function hubRows(
  dataset: string,
  { config = "default", split = "train" }: { config?: string; split?: string } = {},
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; ; offset += PAGE) {
    const query = new URLSearchParams({
      dataset,
      config,
      split,
      offset: String(offset),
      length: String(PAGE),
    });
    // No token: the rows API serves public datasets only here (gated ones go through hubFile).
    const page = (await (await get(`${ROWS_API}?${query}`)).json()) as RowsPage;
    for (const { row_idx, row, truncated_cells } of page.rows) {
      if (truncated_cells && truncated_cells.length > 0) {
        throw new Error(
          `${dataset} row ${row_idx}: cells ${truncated_cells.join(", ")} truncated by the rows` +
            " API — fetch the parquet/JSON file at a pinned revision instead",
        );
      }
      rows.push(row);
    }
    if (page.rows.length === 0 || offset + PAGE >= page.num_rows_total) return rows;
  }
}

interface TreeEntry {
  type: "file" | "directory";
  path: string;
}

/** The next-page URL from a Hub `Link` header, if any. */
function nextPage(link: string | null): string | null {
  const match = /<(?<url>[^>]+)>;\s*rel="next"/.exec(link ?? "");
  return match?.groups?.url ?? null;
}

/** Every entry under `path` at `revision` (recursive when asked), following pagination. */
export async function hubTree(
  dataset: string,
  revision: string,
  path: string,
  { recursive = false }: { recursive?: boolean } = {},
): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  let url: string | null =
    `${HUB}/api/datasets/${dataset}/tree/${revision}/${path}` + (recursive ? "?recursive=true" : "");
  while (url) {
    const response = await get(url);
    entries.push(...((await response.json()) as TreeEntry[]));
    url = nextPage(response.headers.get("link"));
  }
  return entries;
}
