/**
 * The one HTTP helper both remote backends share: POST a JSON body, parse a JSON reply, and
 * retry transient failures (429/5xx/529 and network errors) with exponential backoff, bounded
 * by MAX_TRANSPORT_RETRIES. Abort is honoured mid-sleep as well as mid-request. After the bound
 * the call throws with the status and the start of the body, which agent()/judge() journal.
 */

const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
export const MAX_TRANSPORT_RETRIES = 3;

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        const error = new Error("run aborted");
        error.name = "AbortError";
        rejectSleep(error);
      },
      { once: true },
    );
  });
}

export interface JsonRequest {
  /** Sent verbatim; content-type is added. */
  headers: Record<string, string>;
  /** JSON-serialised. */
  body: unknown;
  signal?: AbortSignal;
  /** Names the service in error messages, e.g. "anthropic". */
  label: string;
}

/** POST `body` as JSON and parse the reply as `Reply` — the shape the service documents. */
export async function postJson<Reply>(url: string, request: JsonRequest): Promise<Reply> {
  const { headers, body, signal, label } = request;
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      if (aborted || attempt >= MAX_TRANSPORT_RETRIES) throw error;
      await sleep(500 * 2 ** attempt, signal);
      continue;
    }
    if (response.ok) return (await response.json()) as Reply;
    const detail = (await response.text()).slice(0, 300);
    if (!RETRIABLE_STATUS.has(response.status) || attempt >= MAX_TRANSPORT_RETRIES) {
      throw new Error(`${label} ${response.status}: ${detail}`);
    }
    await sleep(500 * 2 ** attempt, signal);
  }
}
