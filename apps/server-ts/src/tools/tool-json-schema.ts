import { Predicate, Schema } from "effect"

type JsonObject = Record<string, unknown>

interface ObjectVariant {
  readonly properties: Readonly<Record<string, unknown>>
  readonly required: ReadonlyArray<string>
  readonly closed: boolean
}

const objectVariant = (value: unknown): ObjectVariant | undefined => {
  if (
    !Predicate.isObject(value) ||
    value.type !== "object" ||
    !Predicate.isObject(value.properties)
  ) {
    return undefined
  }
  const required = Array.isArray(value.required)
    ? value.required.filter((name): name is string => typeof name === "string")
    : []
  return { properties: value.properties, required, closed: value.additionalProperties === false }
}

const stringEnum = (value: unknown): ReadonlyArray<unknown> | undefined =>
  Predicate.isObject(value) &&
  value.type === "string" &&
  Array.isArray(value.enum) &&
  Object.keys(value).every((key) => key === "type" || key === "enum")
    ? value.enum
    : undefined

const mergedProperty = (schemas: ReadonlyArray<unknown>): unknown => {
  const distinct = [...new Map(schemas.map((schema) => [JSON.stringify(schema), schema])).values()]
  if (distinct.length === 1) return distinct[0]
  const enums = distinct.map(stringEnum)
  if (enums.every((values) => values !== undefined)) {
    return { type: "string", enum: [...new Set(enums.flat())] }
  }
  return { anyOf: distinct }
}

/**
 * Providers accept only an object at a tool's parameter root (Anthropic
 * rejects a top-level anyOf; OpenAI requires `type: "object"`). A root union
 * of object variants is sent as one object: every variant's properties, the
 * ones every variant requires, and closed when every variant is. Input is
 * still validated against the tool's own schema, so the variant rules hold.
 */
const objectRoot = (schema: JsonObject): JsonObject => {
  if (schema.type === "object" || !Array.isArray(schema.anyOf)) return schema
  const variants = schema.anyOf.map(objectVariant)
  if (!variants.every((variant) => variant !== undefined)) return schema
  const names = [...new Set(variants.flatMap((variant) => Object.keys(variant.properties)))]
  const { anyOf: _variants, ...annotations } = schema
  return {
    ...annotations,
    type: "object",
    properties: Object.fromEntries(
      names.map((name) => [
        name,
        mergedProperty(
          variants.flatMap((variant) =>
            name in variant.properties ? [variant.properties[name]] : []
          )
        )
      ])
    ),
    required: names.filter((name) => variants.every((variant) => variant.required.includes(name))),
    ...(variants.every((variant) => variant.closed) ? { additionalProperties: false } : {})
  }
}

export const toolParametersJsonSchema = (schema: Schema.Constraint): JsonObject => {
  const document = Schema.toJsonSchemaDocument(schema)
  const root = objectRoot(document.schema)
  return Object.keys(document.definitions).length > 0
    ? { ...root, $defs: document.definitions }
    : root
}
