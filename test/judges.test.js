import { afterEach, describe, expect, it, vi } from "vitest";

import { jevJudge } from "../src/judges/jev.js";
import { llmJudge } from "../src/judges/llm.js";

describe("llmJudge", () => {
  /** A backend that records the structured-output request and returns a fixed payload. */
  function payloadBackend(payload) {
    const seen = [];
    const backend = async (request) => {
      seen.push(request);
      return payload;
    };
    return { backend, seen };
  }

  const questions = {
    urgent: { type: "noul", instructions: "Is it urgent?" },
    team: { type: "choice", instructions: "Which team?", criteria: { billing: "money", tech: "bugs", sales: null } },
    mood: { type: "score", instructions: "How angry?", criteria: ["calm", "annoyed", "furious"] },
  };

  it("asks all questions in one schema-forced call and derives Jev-shaped answers", async () => {
    const { backend, seen } = payloadBackend({
      urgent: { yes: 0.9 },
      team: { probabilities: { billing: 0.1, tech: 0.8, sales: 0.1 } },
      mood: { probabilities: { 0: 0.5, 1: 0.5, 2: 0 } },
    });
    const judge = llmJudge(backend, { model: "claude-haiku-4-5-20251001" });
    expect(judge.model).toBe("llm:claude-haiku-4-5-20251001");

    const { answers } = await judge({ state: "Payouts failing for 3 days!", questions });
    expect(answers.urgent).toEqual({ type: "noul", noul: 0.9 });
    expect(answers.team).toEqual({
      type: "choice",
      choice: "tech",
      probabilities: { billing: 0.1, tech: 0.8, sales: 0.1 },
      confidence: 0.8,
    });
    expect(answers.mood).toMatchObject({ type: "score", score: 0.5, confidence: 0.5 });
    expect(answers.mood.legend).toEqual({ 0: "calm", 1: "annoyed", 2: "furious" });

    expect(seen).toHaveLength(1);
    const { schema, prompt, model } = seen[0];
    expect(model).toBe("claude-haiku-4-5-20251001");
    expect(schema.required).toEqual(["urgent", "team", "mood"]);
    expect(schema.properties.team.properties.probabilities.required).toEqual(["billing", "tech", "sales"]);
    expect(schema.properties.mood.properties.probabilities.required).toEqual(["0", "1", "2"]);
    expect(prompt).toContain("Payouts failing for 3 days!");
    expect(prompt).toContain("Which team?");
  });

  it("rescales a distribution that does not sum to 1, breaks ties toward the first option, and rejects no mass", async () => {
    const skewed = llmJudge(payloadBackend({ team: { probabilities: { billing: 0.2, tech: 0.2, sales: 0.4 } } }).backend);
    const { answers } = await skewed({ state: "x", questions: { team: questions.team } });
    expect(answers.team.probabilities).toEqual({ billing: 0.25, tech: 0.25, sales: 0.5 });
    expect(answers.team.choice).toBe("sales");

    const tied = llmJudge(payloadBackend({ team: { probabilities: { billing: 0.5, tech: 0.5, sales: 0 } } }).backend);
    expect((await tied({ state: "x", questions: { team: questions.team } })).answers.team.choice).toBe("billing");

    const empty = llmJudge(payloadBackend({ team: { probabilities: { billing: 0, tech: 0, sales: 0 } } }).backend);
    await expect(empty({ state: "x", questions: { team: questions.team } })).rejects.toThrow(/no probability/);
  });

  it("rejects a backend that returns prose instead of a structured payload", async () => {
    const judge = llmJudge(async () => "probably urgent");
    await expect(judge({ state: "x", questions: { urgent: questions.urgent } })).rejects.toThrow(/no structured payload/);
  });
});

describe("jevJudge", () => {
  afterEach(() => vi.unstubAllGlobals());

  const reply = {
    model: "jev-1.13.0",
    answers: { q: { type: "noul", noul: 0.92 } },
    usage: { input_tokens: 10, output_tokens: 1 },
  };

  it("posts the Jev request shape with a bearer token and returns the reply", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(reply), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const judge = jevJudge({ apiKey: "test-key" });
    expect(judge.model).toBe("jev-latest");

    const questions = { q: { type: "noul", instructions: "Urgent?" } };
    await expect(judge({ state: "Help!", questions })).resolves.toEqual(reply);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body)).toEqual({ model: "jev-latest", state: "Help!", questions });
  });

  it("retries an overloaded reply once, then fails a non-retriable one loudly", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 529 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(reply), { status: 200 }))
      .mockResolvedValueOnce(new Response('{"detail":"bad question"}', { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    const judge = jevJudge({ apiKey: "k", model: "jev-1.13.0" });
    const questions = { q: { type: "noul", instructions: "Urgent?" } };
    await expect(judge({ state: "x", questions })).resolves.toEqual(reply);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(judge({ state: "x", questions })).rejects.toThrow(/jev 422: .*bad question/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
