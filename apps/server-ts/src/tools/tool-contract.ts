import { Effect, Predicate } from "effect"

import type { ServerTool } from "./define.js"
import { catalogNameProblems } from "./tool-catalog.js"
import { toolParametersJsonSchema } from "./tool-json-schema.js"
import { TOOL_SUMMARIES } from "./tool-summaries.js"

/**
 * Rules every built-in tool must keep. The registry refuses to start when one
 * breaks, so any test that boots the server catches a new tool that drifts.
 * MCP tools are not checked: their text comes from outside Arden.
 */
export const checkToolContract = (tools: ReadonlyArray<ServerTool>): Effect.Effect<void> => {
  const problems = toolContractProblems(tools)
  return problems.length === 0
    ? Effect.void
    : Effect.die(new Error(`Built-in tools break their contract:\n${problems.join("\n")}`))
}

const toolContractProblems = (tools: ReadonlyArray<ServerTool>): ReadonlyArray<string> => {
  const names = new Set(tools.map((tool) => tool.definition.name))
  return [
    ...tools.flatMap(readLabelProblems),
    ...tools.flatMap(summaryProblems),
    ...Object.keys(TOOL_SUMMARIES)
      .filter((name) => !names.has(name))
      .map((name) => `TOOL_SUMMARIES has ${name}, which is not a built-in tool`),
    ...tools.flatMap(parameterProblems),
    ...tools.flatMap(groupProblems),
    ...hashInputProblems(tools),
    ...catalogNameProblems(tools)
  ]
}

// Scopes treat action "read" as safe to hand to read-only runs, while the
// approval gate treats any state change as a write. Both must agree.
const readLabelProblems = (tool: ServerTool): ReadonlyArray<string> =>
  tool.meta.action === "read" && tool.meta.changes_state
    ? [`${tool.definition.name} is labeled read but changes state`]
    : []

// The public tool catalog shows this summary; without one it shows nothing.
const summaryProblems = (tool: ServerTool): ReadonlyArray<string> =>
  tool.meta.internal_catalog || TOOL_SUMMARIES[tool.definition.name] !== undefined
    ? []
    : [`${tool.definition.name} has no entry in TOOL_SUMMARIES`]

// Checks the schema the model receives, not the source. `.annotate` on a field
// that transforms its input (Trim, a decoding default) or on a checked struct
// is dropped from that schema; `Schema.annotateEncoded` keeps it. Effect puts
// a description on a checked field inside allOf and on a shared schema inside
// $defs, so look through both. A choice field that only picks a variant (such
// as report's event) passes when the tool description names every choice.
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
  const ref = schema["$ref"]
  if (typeof ref === "string" && described(definitions[ref.replace("#/$defs/", "")], definitions))
    return true
  return ["allOf", "anyOf"].some(
    (key) => Array.isArray(schema[key]) && schema[key].some((part) => described(part, definitions))
  )
}

// Calls in one group run one at a time. A second spelling for the same
// service (drive_write and google_drive_write) let writes overlap.
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

// The model names things by link or slug, never by a hash. It cannot copy 64
// random characters reliably: in one month wiki_read_change failed on 36% of
// its calls and task_propose lost offers to a mistyped snapshot. A version
// check ("did this change since I read it") belongs to the server, per run.
// This finds a hash input by its name or description, so a hash hidden in a
// plainly named field still passes; AGENTS.md states the whole rule.
const HASH_NAME =
  /^(snapshot|fingerprint|etag|checksum|digest|sha256|hash|revision|revision_ref)$|_(hash|sha256|fingerprint|digest|checksum|etag)$/
const HASH_TEXT = /\b(hash|sha-?256|fingerprint|digest|checksum|etag)\b/i

// Inputs that broke the rule when it was written (2026-11-14). Remove an entry
// when its tool stops taking the hash. Never add one.
const KNOWN_HASH_INPUTS: ReadonlySet<string> = new Set([
  "skill_update.expected_sha256",
  "task_propose.snapshot",
  "task_propose.sources.revision",
  "wiki_list_collections.revision",
  "wiki_read_change.revision",
  "wiki_restore_page.revision_ref"
])

const hashInputProblems = (tools: ReadonlyArray<ServerTool>): ReadonlyArray<string> => {
  const found = new Set(tools.flatMap(hashInputs))
  return [
    ...[...found]
      .filter((input) => !KNOWN_HASH_INPUTS.has(input))
      .map(
        (input) =>
          `${input} asks the model for a hash; take a link or slug and keep the version check on the server`
      ),
    ...[...KNOWN_HASH_INPUTS]
      .filter((input) => !found.has(input))
      .map((input) => `KNOWN_HASH_INPUTS has ${input}, which no longer takes a hash; remove it`)
  ]
}

const hashInputs = (tool: ServerTool): ReadonlyArray<string> =>
  hashInputPaths(tool.definition.name, tool.entry(toolParametersJsonSchema).parameters)

/** Every input of one tool, as `tool.field.child`, that asks for a hash. */
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
    const ref = schema["$ref"]
    if (typeof ref === "string") visit(definitions[ref.replace("#/$defs/", "")], path, name)
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

// A fixed choice such as "none" is text the model can copy; free text is not.
const takesText = (schema: Readonly<Record<string, unknown>>): boolean =>
  schema["type"] === "string" && schema["enum"] === undefined && schema["const"] === undefined

const namesHash = (name: string, schema: Readonly<Record<string, unknown>>): boolean =>
  HASH_NAME.test(name) ||
  (typeof schema["description"] === "string" && HASH_TEXT.test(schema["description"]))
