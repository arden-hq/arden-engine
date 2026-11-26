import { PAUSE_REASON, PauseRequested, ToolExecutionError } from "../errors.js"
import {
  CONTENT_BLOCK_TYPE,
  type StandardSchemaV1,
  type ChatMessage,
  type JsonObject,
  type ModelContentBlock
} from "../contracts/messages.js"
import {
  canRunInBackground,
  TOOL_PHASE,
  type EndsTurn,
  type ToolApprovalContext,
  type ToolCallRequest,
  type ToolDisplayTitle,
  type ToolEntry,
  type ToolInputSource,
  type ToolMeta,
  type ToolPhase,
  type ToolProgressUpdate,
  type ToolResult,
  type Toolset
} from "../contracts/tools.js"
import { normalizeToolResult } from "../internal/validate.js"
import { withToolDisplayTitleParameter } from "./display-title.js"
import { truncateToolResult } from "./truncate.js"
import { errorMessage } from "@arden-hq/std/errors"

export interface ToolContext<RunCtx = void> {
  readonly beforeExecute?: ToolCallRequest["beforeExecute"]
  readonly toolCallId: string
  readonly signal: AbortSignal
  readonly approval?: ToolApprovalContext
  readonly run: RunCtx
  readonly messages: ReadonlyArray<ChatMessage>
  readonly emit?: (update: ToolProgressUpdate) => void
}

export interface ToolResultOutput {
  readonly result: string
  readonly preview?: string
  readonly data?: Readonly<Record<string, unknown>>
  readonly host?: Readonly<Record<string, unknown>>
  readonly model_content?: ReadonlyArray<ModelContentBlock>
}

export interface ToolApprovalPrompt<Presentation = unknown> {
  readonly preview?: string
  readonly diff?: string
  readonly presentation?: Presentation
  readonly data?: JsonObject
}

export interface LoopToolMetadata {
  readonly background?: boolean
  readonly detached?: boolean
  readonly hosted?: boolean
  readonly changes_state?: boolean
  readonly concurrency_group?: string | null
  readonly deferred?: boolean
  readonly group?: string
  readonly input_sources?: ReadonlyArray<ToolInputSource>
  readonly ends_turn?: EndsTurn
  readonly approval?: ToolApprovalPolicy
}

export type ToolMetadata<HostMeta extends object = Record<never, never>> = LoopToolMetadata &
  HostMeta

export interface ToolDefinition<
  S extends StandardSchemaV1,
  RunCtx,
  HostMeta extends object = Record<never, never>
> {
  readonly name: string
  readonly description: string
  readonly parameters: S
  readonly parameterJsonSchema?: Readonly<Record<string, unknown>>
  readonly metadata: ToolMetadata<HostMeta>
  readonly approvalPrompt?: (
    input: StandardSchemaV1.InferOutput<S>,
    ctx: ToolContext<RunCtx>
  ) => ToolApprovalPrompt | Promise<ToolApprovalPrompt>
  readonly approvalRequirement?: (
    input: StandardSchemaV1.InferOutput<S>,
    ctx: ToolContext<RunCtx>
  ) => ToolApprovalPrompt | undefined | Promise<ToolApprovalPrompt | undefined>
  readonly execute: (
    input: StandardSchemaV1.InferOutput<S>,
    ctx: ToolContext<RunCtx>
  ) => Promise<ToolResultOutput | string>
}

export interface Tool<RunCtx = void, HostMeta extends object = Record<never, never>> {
  readonly definition: ToolDefinition<StandardSchemaV1, RunCtx, HostMeta>
  readonly entry: (toJsonSchema: JsonSchemaConverter, displayTitle?: ToolDisplayTitle) => ToolEntry
  readonly execute: (
    args: Readonly<Record<string, unknown>>,
    ctx: ToolContext<RunCtx>,
    options?: ToolExecuteOptions<RunCtx, HostMeta>
  ) => Promise<Required<ToolResult>>
}

export const TOOL_APPROVAL_POLICY = { always: "always", ask: "ask", never: "never" } as const
export type ToolApprovalPolicy = (typeof TOOL_APPROVAL_POLICY)[keyof typeof TOOL_APPROVAL_POLICY]

export const TOOL_APPROVAL_DECISION = { approve: "approve", ask: "ask", deny: "deny" } as const
export type ToolApprovalDecision =
  (typeof TOOL_APPROVAL_DECISION)[keyof typeof TOOL_APPROVAL_DECISION]
type CallApprovalDecision = Exclude<ToolApprovalDecision, typeof TOOL_APPROVAL_DECISION.deny>

export interface ToolApprovalCall<RunCtx, HostMeta extends object = Record<never, never>> {
  readonly definition: ToolDefinition<StandardSchemaV1, RunCtx, HostMeta>
  readonly input: unknown
  readonly ctx: ToolContext<RunCtx>
  readonly decision: CallApprovalDecision
}

export type ToolApprovalGate<RunCtx, HostMeta extends object = Record<never, never>> = (
  call: ToolApprovalCall<RunCtx, HostMeta>,
  execute: (ctx: ToolContext<RunCtx>) => Promise<Required<ToolResult>>
) => Promise<Required<ToolResult>>

export interface ToolExecuteOptions<RunCtx, HostMeta extends object = Record<never, never>> {
  readonly decision?: CallApprovalDecision
  readonly gate?: ToolApprovalGate<RunCtx, HostMeta>
  readonly beforeExecute?: ToolCallRequest["beforeExecute"]
  readonly phase?: (phase: ToolPhase) => void
}

export type JsonSchemaConverter = (schema: never) => object

export const applyJsonSchemaConverter = (
  converter: JsonSchemaConverter,
  schema: StandardSchemaV1
): Record<string, unknown> =>
  (converter as (schema: StandardSchemaV1) => Record<string, unknown>)(schema)

export interface CreateToolsetOptions<
  RunCtx = void,
  HostMeta extends object = Record<never, never>
> {
  readonly toJsonSchema: JsonSchemaConverter
  readonly onExecuteError?: (error: unknown, request: ToolCallRequest) => ToolExecutionError
  readonly scope?: Iterable<string>
  readonly approvals?: (
    run: RunCtx,
    names: ReadonlyArray<string>
  ) =>
    | Readonly<Record<string, ToolApprovalDecision>>
    | Promise<Readonly<Record<string, ToolApprovalDecision>>>
  readonly approvalGate?: ToolApprovalGate<RunCtx, HostMeta>
  readonly refusal?: (name: string, reason: "scope" | "denied") => string
  readonly displayTitle?: ToolDisplayTitle
  readonly truncate?: { readonly maxBytes: number; readonly maxLines?: number }
  readonly scrub?: (text: string) => Promise<string>
}

const pathKey = (segment: PropertyKey | StandardSchemaV1.PathSegment): PropertyKey =>
  typeof segment === "object" ? segment.key : segment

const withoutRefusedNulls = (
  value: unknown,
  issues: ReadonlyArray<StandardSchemaV1.Issue>
): unknown =>
  issues.reduce<unknown>((current, issue) => {
    const path = (issue.path ?? []).map(pathKey)
    return path.length === 0 ? current : removeNullAt(current, path)
  }, value)

const removeNullAt = (value: unknown, path: ReadonlyArray<PropertyKey>): unknown => {
  const [head, ...rest] = path
  if (value === null || typeof value !== "object" || head === undefined) return value
  if (Array.isArray(value)) {
    const index = typeof head === "number" ? head : Number(head)
    if (!Number.isInteger(index) || rest.length === 0) return value
    const item = removeNullAt(value[index], rest)
    return item === value[index] ? value : value.map((entry, at) => (at === index ? item : entry))
  }
  const entries = Object.entries(value)
  const found = entries.find(([key]) => key === String(head))
  if (found === undefined) return value
  if (rest.length === 0)
    return found[1] === null
      ? Object.fromEntries(entries.filter(([key]) => key !== found[0]))
      : value
  const field = removeNullAt(found[1], rest)
  return field === found[1]
    ? value
    : Object.fromEntries(entries.map(([key, entry]) => [key, key === found[0] ? field : entry]))
}

export const INVALID_ARGUMENTS_OUTCOME = "invalid_arguments"

const invalidArgumentsResult = (
  name: string,
  issues: ReadonlyArray<StandardSchemaV1.Issue>
): Required<ToolResult> => {
  const detail = issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) =>
          String(typeof segment === "object" && segment !== null ? segment.key : segment)
        )
        .join(".")
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message
    })
    .join("; ")
  return normalizeToolResult({
    content:
      `The ${name} tool was called with invalid arguments: ${detail || "the input does not match the schema"}. ` +
      "Rewrite the input so it satisfies the schema and retry the tool call.",
    preview: "Invalid tool arguments",
    is_error: true,
    retryable: false,
    data: { outcome: INVALID_ARGUMENTS_OUTCOME }
  })
}

const toMeta = <RunCtx, HostMeta extends object>(
  definition: ToolDefinition<StandardSchemaV1, RunCtx, HostMeta>
): ToolMeta => {
  const metadata = definition.metadata
  return {
    name: definition.name,
    ...(metadata.background === true ? { background: true } : {}),
    ...(metadata.detached === true ? { detached: true } : {}),
    ...(metadata.hosted === true ? { hosted: true } : {}),
    changes_state: metadata.changes_state ?? false,
    concurrency_group: metadata.concurrency_group ?? null,
    ends_turn: metadata.ends_turn ?? false,
    deferred: metadata.deferred ?? false,
    ...(metadata.group === undefined ? {} : { group: metadata.group }),
    ...(metadata.input_sources === undefined ? {} : { input_sources: metadata.input_sources }),
    host: hostRecord(metadata)
  }
}

const hostRecord = (metadata: object): Readonly<Record<string, unknown>> => ({ ...metadata })

const outputToResult = (output: ToolResultOutput | string): Required<ToolResult> => {
  const value = typeof output === "string" ? { result: output } : output
  if (typeof value !== "object" || value === null || typeof value.result !== "string") {
    throw new TypeError("tool execute must return a string or a { result } object")
  }
  return normalizeToolResult({
    content: value.result,
    preview: value.preview ?? value.result,
    ...(value.data === undefined ? {} : { data: value.data }),
    ...(value.host === undefined ? {} : { host: value.host }),
    ...(value.model_content === undefined ? {} : { model_content: value.model_content })
  })
}

const pauseUntilApproved = async <RunCtx, HostMeta extends object>(
  call: ToolApprovalCall<RunCtx, HostMeta>,
  execute: (ctx: ToolContext<RunCtx>) => Promise<Required<ToolResult>>
): Promise<Required<ToolResult>> => {
  const { definition, input, ctx } = call
  const required =
    definition.approvalRequirement === undefined
      ? undefined
      : await definition.approvalRequirement(input, ctx)
  if (
    ctx.approval !== undefined ||
    (required === undefined && call.decision !== TOOL_APPROVAL_DECISION.ask)
  )
    return execute(ctx)
  const prompt =
    required ??
    (definition.approvalPrompt === undefined
      ? { preview: definition.description }
      : await definition.approvalPrompt(input, ctx))
  throw new PauseRequested(PAUSE_REASON.approval, prompt.preview, prompt)
}

export const createTool = <
  S extends StandardSchemaV1,
  RunCtx = void,
  HostMeta extends object = Record<never, never>
>(
  definition: ToolDefinition<S, RunCtx, HostMeta>
): Tool<RunCtx, HostMeta> => {
  if (typeof definition.name !== "string" || definition.name.length === 0) {
    throw new TypeError("createTool requires a non-empty name")
  }
  if (typeof definition.metadata !== "object" || definition.metadata === null) {
    throw new TypeError(`createTool(${definition.name}) requires a metadata object`)
  }
  if (typeof definition.parameters?.["~standard"]?.validate !== "function") {
    throw new TypeError(`createTool(${definition.name}) requires Standard Schema parameters`)
  }
  if (definition.metadata.background === true && !canRunInBackground(definition.metadata)) {
    throw new TypeError(
      `createTool(${definition.name}): hosted, turn-ending and detached tools cannot run in the background`
    )
  }
  const erased = definition as unknown as ToolDefinition<StandardSchemaV1, RunCtx, HostMeta>
  const execute = async (
    args: Readonly<Record<string, unknown>>,
    ctx: ToolContext<RunCtx>,
    options: ToolExecuteOptions<RunCtx, HostMeta> = {}
  ): Promise<Required<ToolResult>> => {
    const sent = ctx.approval?.edited?.arguments ?? args
    const validate = async (value: unknown) =>
      await definition.parameters["~standard"].validate(value)
    let validated = await validate(sent)
    if (validated.issues !== undefined) {
      const absent = withoutRefusedNulls(sent, validated.issues)
      if (absent !== sent) {
        const retried = await validate(absent)
        if (retried.issues === undefined) validated = retried
      }
    }
    if (validated.issues !== undefined) {
      return invalidArgumentsResult(definition.name, validated.issues)
    }
    const input = validated.value
    const gate = options.gate ?? pauseUntilApproved
    options.phase?.(TOOL_PHASE.waiting)
    return gate(
      {
        definition: erased,
        input,
        ctx,
        decision:
          options.decision ??
          (definition.metadata.approval === TOOL_APPROVAL_POLICY.ask
            ? TOOL_APPROVAL_DECISION.ask
            : TOOL_APPROVAL_DECISION.approve)
      },
      async (callCtx) => {
        const refusal = await options.beforeExecute?.()
        if (refusal !== undefined) return normalizeToolResult(refusal)
        options.phase?.(TOOL_PHASE.executing)
        return outputToResult(await definition.execute(input, callCtx))
      }
    )
  }
  return Object.freeze({
    definition: erased,
    entry: (toJsonSchema: JsonSchemaConverter, displayTitle?: ToolDisplayTitle): ToolEntry => {
      const parameters =
        definition.parameterJsonSchema ??
        applyJsonSchemaConverter(toJsonSchema, definition.parameters)
      return {
        description: definition.description,
        parameters:
          displayTitle === undefined
            ? parameters
            : withToolDisplayTitleParameter(parameters, definition.name, displayTitle),
        meta: toMeta(erased)
      }
    },
    execute
  })
}

const defaultExecuteError = (error: unknown, request: ToolCallRequest): ToolExecutionError =>
  new ToolExecutionError(errorMessage(error), {
    diagnosticRef: `tool-call:${request.toolCallId}`,
    retryable: null
  })

const neverAborted = new AbortController().signal

export const createToolset = <RunCtx, HostMeta extends object = Record<never, never>>(
  tools: ReadonlyArray<Tool<RunCtx, HostMeta>>,
  options: CreateToolsetOptions<RunCtx, HostMeta>
): ((run: RunCtx) => Toolset) => {
  if (typeof options?.toJsonSchema !== "function") {
    throw new TypeError("createToolset requires a toJsonSchema converter")
  }
  const byName = new Map<string, Tool<RunCtx, HostMeta>>()
  for (const tool of tools) {
    if (byName.has(tool.definition.name)) {
      throw new TypeError(`createToolset received duplicate tool name: ${tool.definition.name}`)
    }
    byName.set(tool.definition.name, tool)
  }
  const truncate = options.truncate
  if (truncate !== undefined) {
    truncateToolResult("", truncate)
  }
  const applyTruncation = (result: Required<ToolResult>): Required<ToolResult> => {
    if (truncate === undefined) return result
    const content = truncateToolResult(result.content, truncate)
    return content === result.content ? result : { ...result, content }
  }
  const scrub = options.scrub
  const scrubResult = async (result: Required<ToolResult>): Promise<Required<ToolResult>> => {
    if (scrub === undefined) return result
    const [content, preview] = await Promise.all([scrub(result.content), scrub(result.preview)])
    const modelContent = await Promise.all(
      result.model_content.map(async (block) => {
        if (block.type === CONTENT_BLOCK_TYPE.text)
          return { ...block, text: await scrub(block.text) }
        if (block.type === CONTENT_BLOCK_TYPE.context && typeof block.content === "string")
          return { ...block, content: await scrub(block.content) }
        return block
      })
    )
    return { ...result, content, preview, model_content: modelContent }
  }
  const scrubFailure = async (failure: ToolExecutionError): Promise<ToolExecutionError> => {
    if (scrub === undefined) return failure
    const message = await scrub(failure.message)
    if (message === failure.message) return failure
    return new ToolExecutionError(message, {
      ...(failure.preview === undefined ? {} : { preview: failure.preview }),
      ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
      ...(failure.diagnosticRef === undefined ? {} : { diagnosticRef: failure.diagnosticRef }),
      ...(failure.host === undefined ? {} : { host: failure.host })
    })
  }
  const scope = options.scope === undefined ? null : new Set(options.scope)
  const displayTitle = options.displayTitle
  const allEntries = tools.map((tool) => tool.entry(options.toJsonSchema, displayTitle))
  const entries =
    scope === null ? allEntries : allEntries.filter((entry) => scope.has(entry.meta.name))
  const metas = new Map(allEntries.map((entry) => [entry.meta.name, entry.meta]))
  const entryNames = entries.map((entry) => entry.meta.name)
  const onExecuteError = options.onExecuteError ?? defaultExecuteError
  const approvals = options.approvals

  return (run: RunCtx): Toolset => {
    const loaded = new Set<string>()
    return {
      ...(displayTitle === undefined ? {} : { displayTitle }),
      entries:
        approvals === undefined
          ? () => entries
          : async () => {
              const decisions = await approvals(run, entryNames)
              return entries.filter(
                (entry) => decisions[entry.meta.name] !== TOOL_APPROVAL_DECISION.deny
              )
            },
      metadata: (name) => metas.get(name),
      loadedNames: () => new Set(loaded),
      load: (names) => {
        for (const name of names) if (byName.has(name)) loaded.add(name)
      },
      seedLoadedNames: (names) => {
        for (const name of names) if (byName.has(name)) loaded.add(name)
      },
      execute: async (request: ToolCallRequest): Promise<Required<ToolResult>> => {
        const tool = byName.get(request.name)
        if (tool === undefined) {
          throw new ToolExecutionError(`Tool '${request.name}' does not exist in this toolset.`, {
            retryable: false
          })
        }
        try {
          if (scope !== null && !scope.has(request.name)) {
            throw new ToolExecutionError(
              options.refusal?.(request.name, "scope") ??
                `Tool is outside this run's scope: ${request.name}`,
              { preview: "Tool out of scope", retryable: false }
            )
          }
          const approvalDecision =
            approvals === undefined
              ? undefined
              : ((await approvals(run, [request.name]))[request.name] ??
                TOOL_APPROVAL_DECISION.approve)
          if (approvalDecision === TOOL_APPROVAL_DECISION.deny) {
            throw new ToolExecutionError(
              options.refusal?.(request.name, "denied") ??
                `Tool denied by settings: ${request.name}`,
              { preview: "Not allowed here", retryable: false }
            )
          }
          return applyTruncation(
            await scrubResult(
              await tool.execute(
                request.args,
                {
                  toolCallId: request.toolCallId,
                  signal: request.signal ?? neverAborted,
                  ...(request.approval === undefined ? {} : { approval: request.approval }),
                  run,
                  messages: request.messages ?? [],
                  ...(request.beforeExecute === undefined
                    ? {}
                    : { beforeExecute: request.beforeExecute }),
                  ...(request.emit === undefined ? {} : { emit: request.emit })
                },
                {
                  ...(approvalDecision === undefined ? {} : { decision: approvalDecision }),
                  ...(options.approvalGate === undefined ? {} : { gate: options.approvalGate }),
                  ...(request.beforeExecute === undefined
                    ? {}
                    : { beforeExecute: request.beforeExecute }),
                  ...(request.phase === undefined ? {} : { phase: request.phase })
                }
              )
            )
          )
        } catch (cause) {
          if (cause instanceof PauseRequested) throw cause
          if (cause instanceof ToolExecutionError) throw await scrubFailure(cause)
          throw await scrubFailure(onExecuteError(cause, request))
        }
      }
    }
  }
}
