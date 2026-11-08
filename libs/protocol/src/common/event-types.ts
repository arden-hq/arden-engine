import type { Schema } from "effect"

// Effect schemas are callable, so a schema is a function with properties.
const isSchemaNode = (value: unknown): value is Readonly<Record<string, unknown>> =>
  (typeof value === "object" || typeof value === "function") && value !== null

/** A `Schema.Literal` carries its value as `literal`. */
const literalOf = (value: unknown): string | undefined =>
  isSchemaNode(value) && typeof value.literal === "string" ? value.literal : undefined

/**
 * The `type` literal of every member of a tagged event union, nested unions
 * included. Read from the runtime schemas so the set can never drift from what
 * the decoder accepts: a union contributes its members, a struct its `type`
 * field, and a wrapped struct (extras, checks) the struct it wraps.
 */
export const eventTypeLiterals = (members: ReadonlyArray<Schema.Top>): ReadonlySet<string> => {
  const found = new Set<string>()
  const walk = (value: unknown): void => {
    if (!isSchemaNode(value)) return
    if (Array.isArray(value.members)) {
      for (const member of value.members) walk(member)
      return
    }
    if (isSchemaNode(value.fields)) {
      const literal = literalOf(value.fields.type)
      if (literal !== undefined) found.add(literal)
      return
    }
    if ("schema" in value) walk(value.schema)
  }
  for (const member of members) walk(member)
  return found
}
