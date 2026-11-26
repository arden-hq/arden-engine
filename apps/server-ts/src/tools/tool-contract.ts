import { TOOL_ACTION } from "@arden-hq/protocol/tools"
import { Effect, Predicate } from "effect"

import { summaryOf, type ServerTool } from "./define.js"
import { catalogNameProblems } from "./tool-catalog.js"
import {
  isSchemaOfType,
  JSON_SCHEMA_TYPE,
  takesAnyValue,
  toolParametersJsonSchema
} from "./tool-json-schema.js"

export const checkToolContract = (tools: ReadonlyArray<ServerTool>): Effect.Effect<void> => {
  const problems = toolContractProblems(tools)
  return problems.length === 0
    ? Effect.void
    : Effect.die(new Error(`Built-in tools break their contract:\n${problems.join("\n")}`))
}

const toolContractProblems = (tools: ReadonlyArray<ServerTool>): ReadonlyArray<string> => {
  return [
    ...tools.flatMap(readLabelProblems),
    ...tools.flatMap(summaryProblems),
    ...tools.flatMap(parameterProblems),
    ...tools.flatMap((tool) =>
      objectRootProblems(tool.definition.name, tool.entry(toolParametersJsonSchema).parameters)
    ),
    ...tools.flatMap(groupProblems),
    ...hashInputProblems(tools),
    ...catalogNameProblems(tools)
  ]
}

const readLabelProblems = (tool: ServerTool): ReadonlyArray<string> =>
  tool.meta.action === TOOL_ACTION.read && tool.meta.changes_state
    ? [`${tool.definition.name} is labeled read but changes state`]
    : []

const summaryProblems = (tool: ServerTool): ReadonlyArray<string> => {
  if (tool.meta.internal_catalog) return []
  const summary = summaryOf(tool.definition)
  if (summary === undefined) return [`${tool.definition.name} has no summary`]
  return summary.trim() === "" ? [`${tool.definition.name} has an empty summary`] : []
}

const parameterProblems = (tool: ServerTool): ReadonlyArray<string> => {
  const entry = tool.entry(toolParametersJsonSchema)
  const properties = entry.parameters["properties"]
  const definitions = Predicate.isObject(entry.parameters["$defs"]) ? entry.parameters["$defs"] : {}
  if (!Predicate.isObject(properties)) return []
  return Object.entries(properties)
    .filter(
      ([, schema]) => !described(schema, definitions) && !choicesNamed(schema, entry.description)
    )
    .map(([param]) => `${tool.definition.name}.${param} has no description`)
}

const choicesNamed = (schema: unknown, description: string): boolean =>
  Predicate.isObject(schema) &&
  Array.isArray(schema["enum"]) &&
  schema["enum"].every((choice) => typeof choice === "string" && description.includes(choice))

const described = (schema: unknown, definitions: Readonly<Record<string, unknown>>): boolean => {
  if (!Predicate.isObject(schema)) return false
  if (typeof schema["description"] === "string" && schema["description"].trim() !== "") return true
  const pointer = schema["$ref"]
  if (
    typeof pointer === "string" &&
    described(definitions[pointer.replace("#/$defs/", "")], definitions)
  )
    return true
  return ["allOf", "anyOf"].some(
    (key) => Array.isArray(schema[key]) && schema[key].some((part) => described(part, definitions))
  )
}

export const objectRootProblems = (
  tool: string,
  parameters: Readonly<Record<string, unknown>>
): ReadonlyArray<string> =>
  isSchemaOfType(parameters, JSON_SCHEMA_TYPE.object)
    ? []
    : [
        `${tool} parameters must be type "object" at the root; an empty input is EmptyParametersSchema`
      ]

const CONCURRENCY_GROUPS: ReadonlySet<string> = new Set([
  "agent_messages",
  "agent_spawn",
  "app_navigation",
  "automation_followup",
  "automations",
  "browser",
  "calendar_write",
  "code_mode",
  "communication",
  "computer",
  "computer_repl",
  "conversation_artifacts",
  "directives",
  "drive_write",
  "filesystem",
  "gmail_write",
  "mac_apps_write",
  "research_workspace",
  "session_todo",
  "sessions",
  "skills",
  "space_work",
  "terminal",
  "web",
  "wiki_write",
  "workflow_control"
])

const groupProblems = (tool: ServerTool): ReadonlyArray<string> => {
  const group = tool.meta.concurrency_group
  return group === null || CONCURRENCY_GROUPS.has(group)
    ? []
    : [
        `${tool.definition.name} uses concurrency group ${group}; add it to CONCURRENCY_GROUPS or reuse one`
      ]
}

const HASH_NAME =
  /^(snapshot|fingerprint|etag|checksum|digest|sha256|hash|revision|revision_ref)$|_(hash|sha256|fingerprint|digest|checksum|etag)$/
const HASH_TEXT = /\b(hash|sha-?256|fingerprint|digest|checksum|etag)\b/i

const hashInputProblems = (tools: ReadonlyArray<ServerTool>): ReadonlyArray<string> =>
  [...new Set(tools.flatMap(hashInputs))].map(
    (input) =>
      `${input} asks the model for a hash; take a link or slug and keep the version check on the run (ctx.run.observations)`
  )

const hashInputs = (tool: ServerTool): ReadonlyArray<string> =>
  hashInputPaths(tool.definition.name, tool.entry(toolParametersJsonSchema).parameters)

export const hashInputPaths = (
  tool: string,
  parameters: Readonly<Record<string, unknown>>
): ReadonlyArray<string> => {
  const definitions = Predicate.isObject(parameters["$defs"]) ? parameters["$defs"] : {}
  const found = new Set<string>()
  const seen = new Set<unknown>()
  const visit = (schema: unknown, path: string, name: string | undefined): void => {
    if (!Predicate.isObject(schema) || seen.has(schema)) return
    seen.add(schema)
    const pointer = schema["$ref"]
    if (typeof pointer === "string") visit(definitions[pointer.replace("#/$defs/", "")], path, name)
    if (name !== undefined && takesText(schema) && namesHash(name, schema)) found.add(path)
    for (const key of ["allOf", "anyOf", "oneOf"])
      if (Array.isArray(schema[key])) for (const part of schema[key]) visit(part, path, name)
    visit(schema["items"], path, undefined)
    const properties = schema["properties"]
    if (Predicate.isObject(properties))
      for (const [child, value] of Object.entries(properties))
        visit(value, `${path}.${child}`, child)
  }
  visit(parameters, tool, undefined)
  return [...found]
}

const takesText = (schema: Readonly<Record<string, unknown>>): boolean =>
  isSchemaOfType(schema, JSON_SCHEMA_TYPE.string) && takesAnyValue(schema)

const namesHash = (name: string, schema: Readonly<Record<string, unknown>>): boolean =>
  HASH_NAME.test(name) ||
  (typeof schema["description"] === "string" && HASH_TEXT.test(schema["description"]))
