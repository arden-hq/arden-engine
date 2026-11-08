import { clipLine } from "@arden-hq/std/text"
import { ToolExecutionError } from "@arden-hq/loop"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import type { AutomationTriggerInput } from "@arden-hq/protocol/automations"
import type { McpServer } from "@arden-hq/protocol/mcp"
import { Effect } from "effect"

const LISTED_EVENTS = 40

const availableWords = (servers: ReadonlyArray<McpServer>): string => {
  const events = servers
    .filter((server) => server.status === "connected")
    .flatMap((server) =>
      server.events.map((event) => {
        const properties = event.inputSchema["properties"]
        const names =
          typeof properties === "object" && properties !== null ? Object.keys(properties) : []
        const description = clipLine(event.description, 160)
        return `${server.name}/${event.name}${names.length === 0 ? "" : ` (arguments: ${names.join(", ")})`}${description === "" ? "" : ` – ${description}`}`
      })
    )
  if (events.length === 0) return "No connected app lists events right now."
  const shown = events.slice(0, LISTED_EVENTS)
  return `Events connected apps list: ${shown.join("; ")}${events.length > shown.length ? `; and ${events.length - shown.length} more` : ""}.`
}

const appEventProblem = (
  triggers: ReadonlyArray<AutomationTriggerInput>,
  servers: ReadonlyArray<McpServer>,
  options: { readonly creating: boolean }
): string | undefined => {
  const validator = new AjvJsonSchemaValidator()
  for (const trigger of triggers) {
    if (trigger.type !== "event" || trigger.event_type !== "mcp.event") continue
    const selector = trigger.mcp_event
    if (selector === undefined || selector === null) {
      if (!options.creating && selector === undefined) continue
      return `An mcp.event trigger needs mcp_event. ${availableWords(servers)}`
    }
    const server = servers.find((candidate) => candidate.name === selector.server)
    if (server === undefined) {
      return `No MCP app is named ${JSON.stringify(selector.server)}. ${availableWords(servers)}`
    }
    if (server.status !== "connected") {
      return `The MCP app ${JSON.stringify(server.name)} is not connected, so its events are unknown. The user connects it in Settings first.`
    }
    const event = server.events.find((candidate) => candidate.name === selector.event)
    if (event === undefined) {
      return `${JSON.stringify(server.name)} lists no event ${JSON.stringify(selector.event)}. ${availableWords(servers)}`
    }
    const checked = validator.getValidator(event.inputSchema)(selector.arguments ?? {})
    if (!checked.valid) {
      return `The arguments for ${server.name}/${event.name} do not match its input schema: ${checked.errorMessage ?? "invalid"}. Schema: ${JSON.stringify(event.inputSchema).slice(0, 2_000)}`
    }
  }
  return undefined
}

export const assertAppEvents = async (
  triggers: ReadonlyArray<AutomationTriggerInput> | undefined,
  apps: () => Effect.Effect<ReadonlyArray<McpServer>>,
  options: { readonly creating: boolean }
): Promise<void> => {
  const listens = triggers?.some(
    (trigger) => trigger.type === "event" && trigger.event_type === "mcp.event"
  )
  if (triggers === undefined || listens !== true) return
  const problem = appEventProblem(triggers, await Effect.runPromise(apps()), options)
  if (problem !== undefined) {
    throw new ToolExecutionError(problem, { preview: "App event unavailable", retryable: false })
  }
}
