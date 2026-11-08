import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import type { ToolDefaultApproval } from "@arden-hq/protocol/tools"
import { engineOrderedJson } from "@arden-hq/std/json"
import { mcpToolName } from "./naming.js"
import { currentMillis } from "../runtime/clock.js"
import { sha256Hex } from "@arden-hq/std/hash"

const LIST_TIMEOUT_MS = 30_000
const MAX_LIST_PAGES = 100
const MAX_TOOLS = 2_048
const MAX_CURSOR_BYTES = 64 * 1_024
const MAX_SCHEMA_BYTES = 128 * 1_024

export interface McpToolBinding {
  readonly serverName: string
  readonly serverTitle: string
  readonly remoteName: string
  readonly fullName: string
  readonly title: string | null
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly validate: JsonSchemaValidator<Readonly<Record<string, unknown>>>
  readonly validateOutput?: JsonSchemaValidator<Readonly<Record<string, unknown>>>
  readonly contract: string
  readonly outputContract?: string
  readonly executionIdentity?: true
  readonly defaultApproval: ToolDefaultApproval
  readonly readOnly: boolean
  readonly destructive: boolean
  readonly idempotent: boolean
  readonly openWorld: boolean
}

/**
 * A tool's MCP annotation hints (spec 2025-06-18), each absent or malformed
 * hint read as its cautious default: it may write (`readOnlyHint` false),
 * may destroy (`destructiveHint` true), is not safe to repeat
 * (`idempotentHint` false) and reaches outside services (`openWorldHint`
 * true). The server is untrusted, so only an explicit boolean moves a hint
 * off its default. A read-only tool destroys nothing.
 */
const toolHints = (
  annotations: ToolAnnotations | undefined
): Pick<McpToolBinding, "readOnly" | "destructive" | "idempotent" | "openWorld"> => {
  const readOnly = annotations?.readOnlyHint === true
  return {
    readOnly,
    destructive: !readOnly && annotations?.destructiveHint !== false,
    idempotent: annotations?.idempotentHint === true,
    openWorld: annotations?.openWorldHint !== false
  }
}

const mcpToolContract = (
  inputSchema: Readonly<Record<string, unknown>>,
  hints: ReturnType<typeof toolHints>,
  executionIdentity = false
): string => sha256Hex(engineOrderedJson({ inputSchema, hints, executionIdentity }))

export interface McpToolCatalogOptions {
  readonly serverName: string
  readonly serverTitle: string
  readonly approval: (remoteName: string) => ToolDefaultApproval
}

/** SDK tools are validated, but its schema aliases disagree under exact optional types. */
const schemaValidator = <A>(
  validator: AjvJsonSchemaValidator,
  schema: Readonly<Record<string, unknown>>
): JsonSchemaValidator<A> => validator.getValidator<A>(schema)

const checkedSchema = (
  schema: Readonly<Record<string, unknown>>,
  toolName: string
): Readonly<Record<string, unknown>> => {
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_SCHEMA_BYTES) {
    throw new Error(`MCP tool ${toolName} schema is too large`)
  }
  return schema
}

export const listMcpTools = async (
  client: Pick<Client, "listTools">,
  options: McpToolCatalogOptions
): Promise<ReadonlyArray<McpToolBinding>> => {
  const deadline = currentMillis() + LIST_TIMEOUT_MS
  const validator = new AjvJsonSchemaValidator()
  const seenCursors = new Set<string>()
  const seenNames = new Set<string>()
  const seenFullNames = new Set<string>()
  const tools: McpToolBinding[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const remaining = deadline - currentMillis()
    if (remaining <= 0) throw new Error("MCP tool catalog timed out")
    const result = await client.listTools(cursor === undefined ? undefined : { cursor }, {
      timeout: remaining,
      maxTotalTimeout: remaining
    })
    for (const tool of result.tools) {
      if (tool.execution?.taskSupport === "required") {
        throw new Error(`MCP tool ${tool.name} requires unsupported task execution`)
      }
      if (tool.name.length === 0 || tool.name.length > 256) {
        throw new Error("MCP tool name is outside the supported size")
      }
      if (seenNames.has(tool.name)) throw new Error(`MCP server repeated tool ${tool.name}`)
      const fullName = mcpToolName(options.serverName, tool.name)
      if (seenFullNames.has(fullName)) throw new Error(`MCP tool name collision: ${fullName}`)
      seenNames.add(tool.name)
      seenFullNames.add(fullName)
      const inputSchema = checkedSchema(tool.inputSchema, tool.name)
      const hints = toolHints(tool.annotations)
      const executionIdentity = tool._meta?.["arden/execution"] === true
      const outputSchema =
        tool.outputSchema === undefined ? undefined : checkedSchema(tool.outputSchema, tool.name)
      tools.push({
        serverName: options.serverName,
        serverTitle: options.serverTitle,
        remoteName: tool.name,
        fullName,
        title: (tool.title ?? tool.annotations?.title)?.slice(0, 512) ?? null,
        description: (tool.description ?? `MCP tool from ${options.serverName}`).slice(0, 32_768),
        inputSchema,
        validate: schemaValidator(validator, inputSchema),
        ...(outputSchema === undefined
          ? {}
          : {
              validateOutput: schemaValidator(validator, outputSchema),
              outputContract: sha256Hex(engineOrderedJson(outputSchema))
            }),
        contract: mcpToolContract(inputSchema, hints, executionIdentity),
        ...(executionIdentity ? { executionIdentity: true as const } : {}),
        defaultApproval: options.approval(tool.name),
        ...hints
      })
      if (tools.length > MAX_TOOLS) throw new Error("MCP tool catalog is too large")
    }
    const next = result.nextCursor
    if (next === undefined) return tools
    if (Buffer.byteLength(next, "utf8") > MAX_CURSOR_BYTES) {
      throw new Error("MCP cursor is too large")
    }
    if (seenCursors.has(next)) throw new Error("MCP server repeated a tools cursor")
    seenCursors.add(next)
    cursor = next
  }
  throw new Error("MCP tool catalog has too many pages")
}
