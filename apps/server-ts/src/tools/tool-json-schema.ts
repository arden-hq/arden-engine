import { Predicate, Schema } from "effect"

type JsonObject = Record<string, unknown>

export const JSON_SCHEMA_TYPE = { object: "object", string: "string" } as const

type JsonSchemaType = (typeof JSON_SCHEMA_TYPE)[keyof typeof JSON_SCHEMA_TYPE]

const JSON_SCHEMA_KEYWORD = { type: "type", enum: "enum", const: "const" } as const

export const isSchemaOfType = (
  schema: Readonly<Record<string, unknown>>,
  type: JsonSchemaType
): boolean => schema[JSON_SCHEMA_KEYWORD.type] === type

export const takesAnyValue = (schema: Readonly<Record<string, unknown>>): boolean =>
  schema[JSON_SCHEMA_KEYWORD.enum] === undefined && schema[JSON_SCHEMA_KEYWORD.const] === undefined

interface ObjectVariant {
  readonly properties: Readonly<Record<string, unknown>>
  readonly required: ReadonlyArray<string>
  readonly closed: boolean
}

const objectVariant = (value: unknown): ObjectVariant | undefined => {
  if (
    !Predicate.isObject(value) ||
    value.type !== JSON_SCHEMA_TYPE.object ||
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
  value.type === JSON_SCHEMA_TYPE.string &&
  Array.isArray(value.enum) &&
  Object.keys(value).every(
    (key) => key === JSON_SCHEMA_KEYWORD.type || key === JSON_SCHEMA_KEYWORD.enum
  )
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

const objectRoot = (schema: JsonObject): JsonObject => {
  if (isSchemaOfType(schema, JSON_SCHEMA_TYPE.object) || !Array.isArray(schema.anyOf)) return schema
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
