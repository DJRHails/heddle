/**
 * Structured output: when an agent call carries a JSON Schema, the backend forces the model to
 * answer through a tool call whose input_schema is that schema, and the runner validates the
 * payload here. A shape mismatch retries the model with the validation errors appended — the
 * script never parses prose — and the retries are bounded: after `maxSchemaRetries` failures the
 * call is a terminal error (the agent resolves null; the journal records why).
 */

import { Ajv } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new Map();

/** Validate `payload` against `schema`. Returns null when valid, else a readable error string. */
export function schemaErrors(schema, payload) {
  const key = JSON.stringify(schema);
  if (!compiled.has(key)) compiled.set(key, ajv.compile(schema));
  const validate = compiled.get(key);
  if (validate(payload)) return null;
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "(root)"} ${error.message}`)
    .join("; ");
}

export const MAX_SCHEMA_RETRIES = 2;
