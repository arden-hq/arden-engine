import { asRecord } from "./items.js"

const schemaMaps = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas"
])
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"])
const schemaValues = new Set([
  "additionalProperties",
  "additionalItems",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contentSchema"
])
const widened = new Set([
  "pattern",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "minContains",
  "maxContains",
  "unevaluatedProperties",
  "unevaluatedItems"
])
const unsupportedScopes = new Set([
  "$id",
  "id",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
  "$vocabulary"
])
const dialects = new Set([
  "http://json-schema.org/draft-04/schema",
  "http://json-schema.org/draft-06/schema",
  "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft/2019-09/schema",
  "https://json-schema.org/draft/2020-12/schema"
])

type Schema = boolean | Readonly<Record<string, unknown>>

interface SchemaNode {
  readonly path: string
  readonly value: Schema
}

/**
 * The Responses backend rejects some valid JS patterns. Omit that assertion only
 * on function parameters. Schema maps contain names; annotations contain opaque
 * data. Neither may be treated as a recursively nested schema.
 *
 * Removing pattern can strengthen not/oneOf/conditionals/counts, including through
 * recursive refs. A changed document deliberately widens those assertions at every
 * schema node. Unsupported reference scopes use open object guidance instead.
 */
export const projectFunctionParameters = (
  parameters: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> => {
  const nodes: Array<SchemaNode> = []
  visit(parameters, "#", nodes)
  if (!nodes.some(({ value }) => typeof value !== "boolean" && "pattern" in value))
    return parameters

  const paths = new Set(nodes.map(({ path }) => path))
  const references: Array<{ readonly path: string; readonly target: string }> = []
  for (const { path, value } of nodes) {
    if (typeof value === "boolean") continue
    if (
      Object.keys(value).some((key) => unsupportedScopes.has(key)) ||
      (value.$schema !== undefined &&
        (typeof value.$schema !== "string" || !dialects.has(value.$schema.replace(/#$/u, ""))))
    )
      return openParameters()
    if (value.$ref === undefined) continue
    const target = localPointer(value.$ref)
    if (target === undefined || !paths.has(target)) return openParameters()
    references.push({ path, target })
  }

  const removed = nodes.flatMap(({ path, value }) =>
    typeof value === "boolean"
      ? []
      : Object.keys(value).flatMap((key) =>
          widened.has(key) || key === "oneOf" ? [childPath(path, key)] : []
        )
  )
  const replaced = new Set<string>()
  // A ref into an omitted applicator becomes {} as a whole. Deleting only $ref
  // could activate siblings ignored by older dialects. Its descendants disappear
  // too, so close that finite set before building the provider copy.
  let changed = true
  while (changed) {
    changed = false
    for (const { path, target } of references) {
      if (replaced.has(path)) continue
      if (
        removed.some((prefix) => target === prefix || target.startsWith(`${prefix}/`)) ||
        [...replaced].some((prefix) => target.startsWith(`${prefix}/`))
      ) {
        replaced.add(path)
        changed = true
      }
    }
  }
  return replaced.has("#") ? openParameters() : project(parameters, "#", replaced)
}

const openParameters = (): Readonly<Record<string, unknown>> => ({
  type: "object",
  properties: {}
})

const childPath = (path: string, key: string): string =>
  `${path}/${key.replace(/~/gu, "~0").replace(/\//gu, "~1")}`

const isSchema = (value: unknown): value is Schema =>
  typeof value === "boolean" || asRecord(value) !== null

const children = (value: Readonly<Record<string, unknown>>, path: string): Array<SchemaNode> =>
  Object.entries(value).flatMap(([key, child]): Array<SchemaNode> => {
    const location = childPath(path, key)
    if (schemaMaps.has(key) || key === "dependencies") {
      const map = asRecord(child)
      return map === null
        ? []
        : Object.entries(map).flatMap(([name, schema]) =>
            isSchema(schema) ? [{ path: childPath(location, name), value: schema }] : []
          )
    }
    if (schemaArrays.has(key) || (key === "items" && Array.isArray(child)))
      return Array.isArray(child)
        ? child.flatMap((schema, index) =>
            isSchema(schema) ? [{ path: childPath(location, String(index)), value: schema }] : []
          )
        : []
    if (schemaValues.has(key) || key === "items")
      return isSchema(child) ? [{ path: location, value: child }] : []
    return []
  })

const visit = (value: Schema, path: string, nodes: Array<SchemaNode>): void => {
  nodes.push({ path, value })
  if (typeof value === "boolean") return
  for (const child of children(value, path)) visit(child.value, child.path, nodes)
}

const localPointer = (reference: unknown): string | undefined => {
  if (typeof reference !== "string" || !reference.startsWith("#")) return undefined
  try {
    const pointer = decodeURIComponent(reference.slice(1))
    if (pointer === "") return "#"
    if (!pointer.startsWith("/") || /~(?:[^01]|$)/u.test(pointer)) return undefined
    return `#${pointer}`
  } catch {
    return undefined
  }
}

const project = (
  value: Readonly<Record<string, unknown>>,
  path: string,
  replaced: ReadonlySet<string>
): Readonly<Record<string, unknown>> => {
  if (replaced.has(path)) return {}
  const projectedChildren = new Map(
    children(value, path).map((child) => [
      child.path,
      typeof child.value === "boolean" ? child.value : project(child.value, child.path, replaced)
    ])
  )
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]): Array<[string, unknown]> => {
      if (widened.has(key)) return []
      if (key === "oneOf" && "anyOf" in value) return []
      const location = childPath(path, key)
      const outputKey = key === "oneOf" ? "anyOf" : key
      if (schemaMaps.has(key) || key === "dependencies") {
        const map = asRecord(child)
        return [
          [
            outputKey,
            map === null
              ? child
              : Object.fromEntries(
                  Object.entries(map).map(([name, schema]) => [
                    name,
                    projectedChildren.get(childPath(location, name)) ?? schema
                  ])
                )
          ]
        ]
      }
      if (Array.isArray(child) && (schemaArrays.has(key) || key === "items"))
        return [
          [
            outputKey,
            child.map(
              (schema, index) => projectedChildren.get(childPath(location, String(index))) ?? schema
            )
          ]
        ]
      return [[outputKey, projectedChildren.get(location) ?? child]]
    })
  )
}
