/**
 * The adversarial research harness: decompose a question into angles, fan out searchers,
 * dedup claims in plain code, deep-read each survivor, run an N-vote refutation panel per
 * claim, and synthesize only what survived.
 *
 * The point of the exercise: the dedup, the vote counting, and the kill threshold are real
 * code. A vote has three outcomes — survived / refuted / could-not-adjudicate — because an
 * errored verifier (a null from agent()) is "no vote cast", never "refuted": infrastructure
 * failure must not read as a finding.
 *
 * Run:  node examples/run-live.js "your research question"
 */

const ANGLES_SCHEMA = {
  type: "object",
  properties: {
    angles: {
      type: "array",
      minItems: 3,
      maxItems: 4,
      items: { type: "string" },
    },
  },
  required: ["angles"],
};

const CLAIMS_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          claim: { type: "string", description: "one specific, falsifiable claim" },
          basis: { type: "string", description: "why this is believed — source or reasoning" },
        },
        required: ["claim", "basis"],
      },
    },
  },
  required: ["claims"],
};

const VOTE_SCHEMA = {
  type: "object",
  properties: {
    refuted: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["refuted", "reason"],
};

const PANEL_SIZE = 3;

/** Plain-code dedup key: casefold, strip punctuation, collapse whitespace, keep content words. */
function claimKey(claim) {
  return claim
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .sort()
    .slice(0, 12)
    .join(" ");
}

export default async function adversarialReview(w) {
  const question = w.args?.question;
  if (!question) throw new Error("pass {args: {question}}");

  // Decompose into distinct search angles — one structured call.
  const decomposition = await w.agent(
    `Decompose this research question into distinct search angles that would surface different` +
      ` evidence:\n\n${question}`,
    { schema: ANGLES_SCHEMA },
  );
  if (!decomposition) throw new Error("decomposition failed — nothing to research");

  // Fan out one searcher per angle. No barrier needed yet: each angle is independent.
  const perAngle = await w.parallel(
    decomposition.angles.map((angle) => () =>
      w.agent(
        `Research question: ${question}\n\nSearch angle: ${angle}\n\nFrom what you know,` +
          ` state the strongest specific, falsifiable claims relevant to this angle. Quality` +
          ` over quantity; include the basis for each.`,
        { schema: CLAIMS_SCHEMA },
      ),
    ),
  );

  // BARRIER + plain-code dedup: this genuinely needs every searcher's output at once.
  const seen = new Map();
  for (const [angleIndex, result] of perAngle.entries()) {
    if (!result) continue; // a dead searcher is a coverage gap, recorded below — not a claim
    for (const { claim, basis } of result.claims) {
      const key = claimKey(claim);
      if (!seen.has(key)) seen.set(key, { claim, basis, angle: decomposition.angles[angleIndex] });
    }
  }
  const deduped = [...seen.values()];
  const deadSearchers = perAngle.filter((r) => r === null).length;

  // Each surviving claim flows through deep-read then panel independently — no barrier, so a
  // slow claim never blocks its neighbours.
  const adjudicated = await w.pipeline(
    deduped,
    (entry) =>
      w
        .agent(
          `Elaborate this claim with its strongest supporting evidence and its known` +
            ` weaknesses, in under 150 words.\n\nClaim: ${entry.claim}\nBasis: ${entry.basis}`,
        )
        .then((reading) => ({ ...entry, reading })),
    async (entry) => {
      const votes = await w.parallel(
        Array.from({ length: PANEL_SIZE }, (_, seat) => () =>
          w.agent(
            `You are refutation panellist ${seat + 1} of ${PANEL_SIZE}. Try to refute this` +
              ` claim; default to refuted=true if the support is weak or the claim overreaches.` +
              `\n\nClaim: ${entry.claim}\n\nDeep read:\n${entry.reading ?? entry.basis}`,
            { schema: VOTE_SCHEMA },
          ),
        ),
      );
      // Three outcomes, and nulls are "no vote cast" — never a refutation, never survival.
      const cast = votes.filter((vote) => vote !== null);
      const refutals = cast.filter((vote) => vote.refuted);
      let verdict = "could-not-adjudicate";
      if (cast.length >= 2) verdict = refutals.length * 2 > cast.length ? "refuted" : "survived";
      return {
        claim: entry.claim,
        angle: entry.angle,
        verdict,
        votesCast: cast.length,
        votesRefuting: refutals.length,
        reasons: cast.map((vote) => vote.reason),
      };
    },
  );

  const rows = adjudicated.filter((row) => row !== null);
  const survived = rows.filter((row) => row.verdict === "survived");
  const synthesis = survived.length
    ? await w.agent(
        `Synthesize an answer to the research question strictly from these claims, each of` +
          ` which survived an adversarial refutation panel. Do not add claims of your own.` +
          `\n\nQuestion: ${question}\n\nSurviving claims:\n` +
          survived.map((row) => `- ${row.claim}`).join("\n"),
      )
    : "(no claim survived the panel)";

  return {
    question,
    angles: decomposition.angles,
    deadSearchers,
    claimsConsidered: deduped.length,
    survived,
    refuted: rows.filter((row) => row.verdict === "refuted"),
    couldNotAdjudicate: rows.filter((row) => row.verdict === "could-not-adjudicate"),
    droppedInPipeline: adjudicated.length - rows.length,
    synthesis,
  };
}
