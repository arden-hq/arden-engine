import {
  PauseRequested,
  callEndsTurn,
  splitToolArguments,
  ToolExecutionError,
  type ToolResult,
  type ToolCallRequest,
  type Toolset
} from "@arden-hq/loop"
import type { Schema } from "effect"
import { TOOL_DISPLAY_TITLE } from "../execution/tool-call-presentation.js"
import type { ServerToolRun } from "../chat/runner-contract.js"
import type {
  CodeModeCallRequest,
  CodeModeHost,
  NestedCallFacts,
  ScriptFields
} from "../workflows/runtime/contract.js"
import {
  refusalReason,
  resolveToolName,
  unknownToolMessage,
  type CodeModeToolFacts
} from "./code-mode-names.js"
import { SCRIPT_RETURNS, type ScriptToolDescription } from "./code-mode-result.js"
import type { ServerTool } from "./define.js"
import { toolParametersJsonSchema } from "./tool-json-schema.js"
import type { BrowserObservationRegistry } from "./run-context.js"
import {
  checkpointBrowserObservation,
  restoreBrowserObservation
} from "./browser-observation-checkpoint.js"

const codeModeResult = (result: ToolResult, fields: ScriptFields | undefined): Schema.Json => ({
  content: result.content,
  preview: result.preview,
  data: result.data == null && fields === undefined ? null : { ...result.data, ...fields }
})

const LIVE_SOURCE_REFS_MAX = 50

const nestedCallFacts = ({ data }: ToolResult): NestedCallFacts => {
  const sources = data?.["source_refs"]
  return {
    ...(Array.isArray(sources) ? { source_refs: sources.slice(0, LIVE_SOURCE_REFS_MAX) } : {}),
    ...(data?.["change_evidence"] === undefined ? {} : { change_evidence: data["change_evidence"] })
  }
}

interface PendingCall {
  result: ToolResult | undefined
  offered: (() => ScriptFields) | undefined
  fields: ScriptFields | undefined
}

export const makeCodeModeHost = (options: {
  readonly run: ServerToolRun
  readonly tools: ReadonlyArray<ServerTool>
  readonly scope: ReadonlySet<string>
  readonly toolset: () => Toolset | undefined
  readonly validateCall?: (request: CodeModeCallRequest) => Promise<void>
  readonly browserObservations?: BrowserObservationRegistry
}): CodeModeHost & {
  readonly captureResult: (request: ToolCallRequest, result: ToolResult) => void
} => {
  const { run, tools } = options
  const pending = new Map<string, PendingCall>()
  const knownNames = new Set(tools.map((tool) => tool.definition.name))
  const facts = (tool: ServerTool): CodeModeToolFacts => ({
    name: tool.definition.name,
    codeMode: tool.meta.code_mode,
    hosted: tool.meta.hosted === true,
    endsTurn: tool.meta.ends_turn !== undefined && tool.meta.ends_turn !== false,
    agentTool: tool.meta.source === "_agents",
    inScope: options.scope.has(tool.definition.name)
  })
  const callable = tools.filter(
    (tool) => tool.meta.invocation_only !== true && refusalReason(facts(tool)) === undefined
  )
  const find = (requested: string): ServerTool | undefined => {
    const resolved = resolveToolName(requested, knownNames)
    return resolved === undefined
      ? undefined
      : tools.find((candidate) => candidate.definition.name === resolved)
  }
  return {
    captureResult: (request, result) => {
      const call = pending.get(request.toolCallId)
      if (call !== undefined) call.result = result
    },
    scriptFields: (toolCallId, fields) => {
      const call = pending.get(toolCallId)
      if (call !== undefined) call.offered = fields
    },
    changesState: (name) => {
      const tool = find(name)
      return (
        tool !== undefined && refusalReason(facts(tool)) === undefined && tool.meta.changes_state
      )
    },
    describe: (name): ScriptToolDescription | undefined => {
      const tool = find(name)
      if (
        tool === undefined ||
        tool.meta.invocation_only === true ||
        refusalReason(facts(tool)) !== undefined
      )
        return undefined
      const entry = tool.entry(toolParametersJsonSchema)
      return {
        name: tool.definition.name,
        description: entry.description,
        input_schema: entry.parameters as Schema.Json,
        returns: SCRIPT_RETURNS,
        changes_state: tool.meta.changes_state
      }
    },
    concurrencyGroup: (name) => {
      const tool = find(name)
      return tool !== undefined && refusalReason(facts(tool)) === undefined
        ? (tool.meta.concurrency_group ?? null)
        : null
    },
    call: async (request: CodeModeCallRequest): Promise<Schema.Json> => {
      const tool = find(request.name)
      if (tool === undefined) {
        throw new ToolExecutionError(
          unknownToolMessage(
            request.name,
            callable.map((candidate) => candidate.definition.name)
          ),
          { preview: "Unknown tool", retryable: false }
        )
      }
      const refusal = refusalReason(facts(tool))
      if (refusal !== undefined) {
        throw new ToolExecutionError(refusal, { preview: "Tool unavailable", retryable: false })
      }
      const toolset = options.toolset()
      if (toolset === undefined) {
        throw new ToolExecutionError("Code Mode toolset is unavailable", {
          preview: "Code Mode unavailable",
          retryable: false
        })
      }
      const metadata = tool.meta
      const toolName = tool.definition.name
      const toolCallId = request.toolCallId
      await options.validateCall?.({ ...request, name: toolName })
      const { args } = splitToolArguments(request.args, undefined, TOOL_DISPLAY_TITLE)
      if (callEndsTurn(metadata, args)) {
        throw new ToolExecutionError(
          `This ${toolName} call ends the run; call it directly, by itself`,
          { preview: "Call it directly", retryable: false }
        )
      }
      const execute = request.detached ? run.executeDetachedTool : run.executeTool
      const captured: PendingCall = { result: undefined, offered: undefined, fields: undefined }
      const browserObservations =
        metadata.source === "_browser" ? options.browserObservations : undefined
      const previousRef =
        typeof args["tab_ref"] === "string"
          ? browserObservations?.latest(args["tab_ref"])?.ref
          : undefined
      pending.set(toolCallId, captured)
      let result: ToolResult | undefined
      try {
        result = await execute(
          {
            toolCallId,
            name: toolName,
            args,
            changesState: metadata.changes_state,
            source: metadata.source
          },
          (context) =>
            Promise.resolve(
              toolset.execute({
                toolCallId,
                name: toolName,
                args,
                signal: request.signal,
                messages: request.messages,
                ...(request.beforeExecute === undefined
                  ? {}
                  : { beforeExecute: request.beforeExecute }),
                ...(context?.approval === undefined ? {} : { approval: { ...context.approval } })
              })
            )
              .then((settled) => {
                if (settled.is_error === true) return settled
                captured.fields = captured.offered?.()
                const checkpoint =
                  browserObservations === undefined
                    ? undefined
                    : checkpointBrowserObservation({
                        observations: browserObservations,
                        args,
                        result: captured.result ?? settled,
                        fields: captured.fields,
                        previousRef
                      })
                return {
                  ...settled,
                  ...(captured.fields === undefined
                    ? {}
                    : { data: { ...settled.data, ...captured.fields } }),
                  ...(checkpoint === undefined
                    ? {}
                    : { host: { ...settled.host, browser_observation: checkpoint } })
                }
              })
              .catch((cause: unknown) => {
                if (
                  request.approvalContinuation === "caller" &&
                  cause instanceof PauseRequested &&
                  cause.reason === "approval"
                ) {
                  throw new ToolExecutionError(
                    `${toolName} requires approval. Make this call directly with the same arguments; the browser worker cannot safely replay its earlier actions.`,
                    { preview: "Approval required", retryable: false }
                  )
                }
                throw cause
              })
        )
      } finally {
        pending.delete(toolCallId)
        if (result !== undefined) request.onSettled?.(nestedCallFacts(result))
      }
      if (result.is_error === true) {
        if (typeof args["tab_ref"] === "string")
          browserObservations?.forget(args["tab_ref"], toolCallId)
        throw new ToolExecutionError(result.content, {
          preview: result.preview,
          retryable: result.retryable === true
        })
      }
      if (captured.result === undefined && browserObservations !== undefined)
        restoreBrowserObservation(browserObservations, result)
      const structured = captured.result ?? result
      request.onResult?.(structured)
      return codeModeResult(structured, captured.fields)
    }
  }
}
