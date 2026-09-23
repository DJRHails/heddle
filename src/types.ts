/**
 * The public contracts: what a script receives (`Workflow`), what the two model seams look like
 * (`Backend` writes, `Judge` decides), and the Jev-shaped question and answer types both judges
 * speak. Everything here is a type; the runtime checks that guard the same boundaries live next
 * to the code they protect, because a script may still be plain JavaScript.
 */

/** A JSON Schema document, as accepted by ajv and by the Messages API's tool `input_schema`. */
export type JsonSchema = Record<string, unknown>;

/** The options an `agent` call carries; the semantic ones also enter the journal key. */
export interface AgentOptions {
  /** Force the answer through structured output matching this schema. */
  schema?: JsonSchema;
  system?: string;
  model?: string;
  maxTokens?: number;
}

export interface BackendRequest extends AgentOptions {
  prompt: string;
  signal?: AbortSignal;
}

/**
 * A backend writes. It resolves the final text, or the schema-conforming payload when a schema
 * was given, and throws after its own bounded retries — `agent()` turns that into `null`.
 */
export type Backend = (request: BackendRequest) => Promise<unknown>;

/** Jev accepts a plain question, or structured instructions carrying data beside it. */
export type Instructions = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: "noul";
  instructions: Instructions;
  /** What counts as a yes and as a no, when the boundary is subtle. */
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: Instructions;
  /** The labels to choose between, each with a description or `null`. */
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: Instructions;
  /** The rubric levels, lowest first; the score is an expected level. */
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  /** p(yes). */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** The answer type a question type produces. */
export type AnswerFor<Q extends Question> = Extract<Answer, { type: Q["type"] }>;

export interface JudgeRequest {
  state: unknown;
  questions: Record<string, Question>;
  signal?: AbortSignal;
}

export interface JudgeResponse {
  model?: string;
  answers: Record<string, Answer>;
  usage?: unknown;
}

/**
 * A judge decides: Jev's request and answer shapes, with a `model` name that enters the journal
 * key so switching judges re-judges. A judgment that cannot be obtained throws.
 */
export interface Judge {
  (request: JudgeRequest): Promise<JudgeResponse>;
  model?: string;
}

export type Thunk<T> = () => T | Promise<T>;

/** One pipeline stage: receives the previous stage's value, the original item, and its index. */
export type Stage<Previous, Item, Next> = (
  previous: Previous,
  item: Item,
  index: number,
) => Next | Promise<Next>;

export interface DecisionOptions {
  /** The winning probability a decision needs; below it the decision is `null` ("unsure"). */
  confidence?: number;
}

/** The api object a script receives as `w`. */
export interface Workflow<Args = unknown> {
  /** One subagent call. Final text, or `null` on terminal failure (the journal has the story). */
  agent(prompt: string, opts?: Omit<AgentOptions, "schema">): Promise<string | null>;
  /** One subagent call forced through `schema`; `T` asserts the shape the schema guarantees. */
  agent<T = unknown>(prompt: string, opts: AgentOptions & { schema: JsonSchema }): Promise<T | null>;
  agent(prompt: string, opts: AgentOptions): Promise<unknown>;

  /** A barrier over thunks (never promises). A thunk that throws becomes `null`. */
  parallel<T>(thunks: ReadonlyArray<Thunk<T>>): Promise<Array<Awaited<T> | null>>;

  /** Per-item chains with no cross-stage barrier. A stage that throws drops its item to `null`. */
  pipeline<A, B>(items: readonly A[], first: Stage<A, A, B>): Promise<Array<B | null>>;
  pipeline<A, B, C>(
    items: readonly A[],
    first: Stage<A, A, B>,
    second: Stage<B, A, C>,
  ): Promise<Array<C | null>>;
  pipeline<A, B, C, D>(
    items: readonly A[],
    first: Stage<A, A, B>,
    second: Stage<B, A, C>,
    third: Stage<C, A, D>,
  ): Promise<Array<D | null>>;
  pipeline<A, B, C, D, E>(
    items: readonly A[],
    first: Stage<A, A, B>,
    second: Stage<B, A, C>,
    third: Stage<C, A, D>,
    fourth: Stage<D, A, E>,
  ): Promise<Array<E | null>>;
  pipeline<A>(items: readonly A[], ...stages: Array<Stage<unknown, A, unknown>>): Promise<unknown[]>;

  /** One typed question about a state, answered with calibrated probabilities. Throws on failure. */
  judge<Q extends Question>(state: unknown, question: Q): Promise<AnswerFor<Q>>;

  /** Does the state fit the description? `null` when the judge is unsure under `confidence`. */
  feels(state: unknown, description: string, opts?: DecisionOptions): Promise<boolean | null>;

  /** Which label fits the state best? `null` when the winner is under `confidence`. */
  match<Label extends string>(
    state: unknown,
    criteria: readonly Label[] | Readonly<Record<Label, string | null>>,
    opts?: DecisionOptions,
  ): Promise<Label | null>;

  /** Whatever `run()` was given as `args`, verbatim. */
  args: Args;
}

/** A heddle script: the default export of the module `run()` is pointed at. */
export type Script<Args = unknown, Result = unknown> = (
  w: Workflow<Args>,
) => Result | Promise<Result>;
