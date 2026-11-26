import type { AgentOutputOptions } from "@arden-hq/loop"
import { JsonSchema, Schema, SchemaRepresentation } from "effect"
import { toCodecOpenAI } from "effect/unstable/ai/OpenAiStructuredOutput"
import { errorMessage } from "@arden-hq/std/errors"
import type { JsonObject } from "../persistence/json.js"

export type StructuredOutputDialect = "openai"

interface ConvertedOutput<T> {
  readonly codec: Schema.ConstraintDecoder<T>
  readonly jsonSchema: Record<string, unknown>
}

type OutputConverter = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S
) => ConvertedOutput<S["Type"]>

const openAiOutput: OutputConverter = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const converted = toCodecOpenAI(schema)
  return {
    codec: converted.codec,
    jsonSchema: converted.jsonSchema
  }
}

export const STRUCTURED_OUTPUT_DIALECTS: Record<StructuredOutputDialect, OutputConverter> = {
  openai: openAiOutput
}

const importJsonSchema = (raw: JsonObject): Schema.Codec<unknown, unknown> =>
  SchemaRepresentation.fromJsonSchemaDocument(
    JsonSchema.fromSchemaDraft2020_12({ ...raw })
  ) as Schema.Codec<unknown, unknown>

export const chatOutputOptions = (
  raw: JsonObject,
  dialect: StructuredOutputDialect
): AgentOutputOptions => {
  const converted = STRUCTURED_OUTPUT_DIALECTS[dialect](importJsonSchema(raw))
  return {
    schema: Schema.toStandardSchemaV1(converted.codec),
    toJsonSchema: () => converted.jsonSchema,
    name: "output"
  }
}

export const outputSchemaProblem = (
  raw: JsonObject,
  dialect: StructuredOutputDialect
): string | undefined => {
  try {
    chatOutputOptions(raw, dialect)
    return undefined
  } catch (cause) {
    return `The output schema is not supported: ${errorMessage(cause)}`
  }
}
