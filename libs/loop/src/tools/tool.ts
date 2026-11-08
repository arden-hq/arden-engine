import { PauseRequested, ToolExecutionError } from "../errors.js"
import type {
  StandardSchemaV1,
  ChatMessage,
  JsonObject,
  ModelContentBlock
} from "../contracts/messages.js"
import {
  canRunInBackground,
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
  /** The owning inference's admission, retained by nested tool effects. */
  readonly beforeExecute?: ToolCallRequest["beforeExecute"]
  readonly toolCallId: string
  /** Per-call signal, tied to run cancellation. */
  readonly signal: AbortSignal
  /** Host-confirmed approval replay for this exact call. */
  readonly approval?: ToolApprovalContext
  /** Typed run-context: session identity, spawn seam, stores. */
  readonly run: RunCtx
  /** Read-only view of the canonical history at call time. */
  readonly messages: ReadonlyArray<ChatMessage>
  /**
   * Push a live progress update for this call (a `ToolProgress` stream event).
   * Fire-and-forget: it never throws and is safe to call after the call has
   * settled — late emits are dropped. Parallel tools interleave their
   * progress events in emission order.
   */
  readonly emit?: (update: ToolProgressUpdate) => void
}

export interface ToolResultOutput {
  /** Model-facing text. */
  readonly result: string
  /** UI-facing preview (host metadata rides ToolMeta.host). */
  readonly preview?: string
  readonly data?: Readonly<Record<string, unknown>>
  /** Extra host metadata merged into the ToolFinished event. */
  readonly host?: Readonly<Record<string, unknown>>
  /** Becomes the is_meta tool-media envelope. */
  readonly model_content?: ReadonlyArray<ModelContentBlock>
}

/** The card a paused call shows; `presentation` is the host's own shape. */
export interface ToolApprovalPrompt<Presentation = unknown> {
  readonly preview?: string
  readonly diff?: string
  readonly presentation?: Presentation
  readonly data?: JsonObject
}

/** The metadata keys the loop reads. */
export interface LoopToolMetadata {
  /**
   * Start in the background at once, so the model continues independent work.
   * Every other call that can run in the background moves there when it
   * outlives the loop's foreground budget.
   */
  readonly background?: boolean
  /**
   * Starts its own long-running job and returns a handle to it (a child Agent,
   * a workflow, a detached process). Its lifecycle already runs outside the
   * turn, so the loop never runs it in the background as well.
   */
  readonly detached?: boolean
  /** Executes upstream rather than through the local toolset. */
  readonly hosted?: boolean
  /** Write lock in the fair read/write group. */
  readonly changes_state?: boolean
  readonly concurrency_group?: string | null
  readonly deferred?: boolean
  /** The namespace a deferred tool is found and loaded under. */
  readonly group?: string
  /** Tools that produce this tool's required inputs; search loads them with it. */
  readonly input_sources?: ReadonlyArray<ToolInputSource>
  readonly ends_turn?: EndsTurn
  /** "ask" pauses every call until the host replays an approval; "always"/"never" are host vocabulary. */
  readonly approval?: "always" | "ask" | "never"
}

/**
 * A tool's policy bag: the loop's keys plus the host's own. The whole bag
 * rides `ToolMeta.host` on catalog entries and events.
 */
export type ToolMetadata<HostMeta extends object = Record<never, never>> = LoopToolMetadata &
  HostMeta

export interface ToolDefinition<
  S extends StandardSchemaV1,
  RunCtx,
  HostMeta extends object = Record<never, never>
> {
  readonly name: string
  readonly description: string
  /** Standard Schema — zod v4, effect Schema, and valibot all conform. */
  readonly parameters: S
  /**
   * Authoritative model-facing JSON Schema when the tool source already owns
   * one, as MCP does. Validation still goes through `parameters`.
   */
  readonly parameterJsonSchema?: Readonly<Record<string, unknown>>
  /** Policy bag; a tool cannot exist without it. */
  readonly metadata: ToolMetadata<HostMeta>
  /** Build the exact approval card after arguments validate. */
  readonly approvalPrompt?: (
    input: StandardSchemaV1.InferOutput<S>,
    ctx: ToolContext<RunCtx>
  ) => ToolApprovalPrompt | Promise<ToolApprovalPrompt>
  /**
   * Require approval for this exact validated call even when host settings
   * otherwise approve the tool. Returning undefined keeps the host decision.
   */
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
  /** Catalog entry; the JSON-Schema converter is host-supplied via createToolset. */
  readonly entry: (toJsonSchema: JsonSchemaConverter, displayTitle?: ToolDisplayTitle) => ToolEntry
  /** Validation, approval gating, and result normalization baked in. */
  readonly execute: (
    args: Readonly<Record<string, unknown>>,
    ctx: ToolContext<RunCtx>,
    options?: ToolExecuteOptions<RunCtx, HostMeta>
  ) => Promise<Required<ToolResult>>
}

/** Host decision for one tool: "deny" hides and refuses, "ask" pauses. */
export type ToolApprovalDecision = "approve" | "ask" | "deny"

/** One validated call on its way to `execute`. */
export interface ToolApprovalCall<RunCtx, HostMeta extends object = Record<never, never>> {
  readonly definition: ToolDefinition<StandardSchemaV1, RunCtx, HostMeta>
  /** The validated arguments. */
  readonly input: unknown
  readonly ctx: ToolContext<RunCtx>
  /** The host's decision for this tool, or the tool's own `approval: "ask"`. */
  readonly decision: "approve" | "ask"
}

/**
 * The host's approval policy for one validated call. It may pause (throw
 * `PauseRequested`), run the call through `execute` — with any context, for
 * example one carrying an approval the host granted itself — and shape the
 * normalized result. Without a gate the loop pauses an "ask" call, or a call
 * whose `approvalRequirement` returns a card, until an approval is replayed.
 */
export type ToolApprovalGate<RunCtx, HostMeta extends object = Record<never, never>> = (
  call: ToolApprovalCall<RunCtx, HostMeta>,
  execute: (ctx: ToolContext<RunCtx>) => Promise<Required<ToolResult>>
) => Promise<Required<ToolResult>>

/** What a toolset hands one call: the host's decision for the tool and its gate. */
export interface ToolExecuteOptions<RunCtx, HostMeta extends object = Record<never, never>> {
  /** Defaults to the tool's own `approval: "ask"`, else "approve". */
  readonly decision?: "approve" | "ask"
  readonly gate?: ToolApprovalGate<RunCtx, HostMeta>
  /** Recheck the owning inference after approval, before the effect begins. */
  readonly beforeExecute?: ToolCallRequest["beforeExecute"]
  /** Where the call is, for the loop's foreground budget (`ToolCallRequest.phase`). */
  readonly phase?: (phase: ToolPhase) => void
}

/**
 * Any Standard-Schema→JSON-Schema function. The `never` parameter makes this
 * contravariantly permissive: `z.toJSONSchema`, effect's `JSONSchema.make`,
 * and hand-written converters all assign without casts; the loop only ever
 * calls it with the schemas the host itself registered.
 */
export type JsonSchemaConverter = (schema: never) => object

/**
 * The ONE place the converter's contravariant `never` parameter is bridged to
 * a real schema — internally the loop only hands it schemas the host itself
 * registered, so the cast is honest here and nowhere else.
 */
export const applyJsonSchemaConverter = (
  converter: JsonSchemaConverter,
  schema: StandardSchemaV1
): Record<string, unknown> =>
  (converter as (schema: StandardSchemaV1) => Record<string, unknown>)(schema)

export interface CreateToolsetOptions<
  RunCtx = void,
  HostMeta extends object = Record<never, never>
> {
  /** Host supplies the Standard-Schema→JSON-Schema conversion ONCE (e.g. zod's `z.toJSONSchema` or effect's `JSONSchema.make` — no casts needed). */
  readonly toJsonSchema: JsonSchemaConverter
  /** Default mapper for plain execute throws. */
  readonly onExecuteError?: (error: unknown, request: ToolCallRequest) => ToolExecutionError
  /**
   * Names this toolset advertises and executes. Tools outside the scope stay
   * metadata-resolvable (the recovery seam) but refuse execution.
   */
  readonly scope?: Iterable<string>
  /**
   * Dynamic per-tool approval decisions (host settings) for the named tools,
   * snapshotted at every entries() call (every advertised name) and execute()
   * call (the called name only): "deny" hides the tool and refuses execution;
   * "ask" reaches the approval gate, which by default throws PauseRequested
   * until the host replays an approval. Hosts that persist pauses durably
   * replay the recorded approval as request.approval and must not gate again
   * themselves.
   */
  readonly approvals?: (
    run: RunCtx,
    names: ReadonlyArray<string>
  ) =>
    | Readonly<Record<string, ToolApprovalDecision>>
    | Promise<Readonly<Record<string, ToolApprovalDecision>>>
  /** The host's approval policy for each validated call (see `ToolApprovalGate`). */
  readonly approvalGate?: ToolApprovalGate<RunCtx, HostMeta>
  /**
   * The model-facing text when a call is refused: `scope` — outside this
   * run's scope; `denied` — an approval decision of "deny". A host that
   * declares tools a run may not call uses it to say what to do instead.
   */
  readonly refusal?: (name: string, reason: "scope" | "denied") => string
  /** Opt-in display-title argument; the returned Toolset carries it for the agent. */
  readonly displayTitle?: ToolDisplayTitle
  /**
   * Central output truncation (`truncateToolResult`), applied to every
   * result's model-facing text after `execute` and before the loop's result
   * normalization. `preview` and `data` are untouched. File spill of the full
   * output stays host-side — the lib touches no filesystem; hosts that want
   * opencode-style "full output saved to X" behavior write the untruncated
   * text themselves (e.g. in a toolCallMiddleware) and append their own hint.
   * Applies to the model-facing `content` text only; `model_content` blocks
   * (tool media) are not truncated — cap those in the tool itself.
   */
  readonly truncate?: { readonly maxBytes: number; readonly maxLines?: number }
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

/** `data.outcome` of a call its schema rejected: the tool never ran. */
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
  if (ctx.approval !== undefined || (required === undefined && call.decision !== "ask"))
    return execute(ctx)
  const prompt =
    required ??
    (definition.approvalPrompt === undefined
      ? { preview: definition.description }
      : await definition.approvalPrompt(input, ctx))
  throw new PauseRequested("approval", prompt.preview, prompt)
}

/** Wrap one co-located definition with validation and approval gating. */
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
    options.phase?.("waiting")
    return gate(
      {
        definition: erased,
        input,
        ctx,
        decision: options.decision ?? (definition.metadata.approval === "ask" ? "ask" : "approve")
      },
      async (callCtx) => {
        const refusal = await options.beforeExecute?.()
        if (refusal !== undefined) return normalizeToolResult(refusal)
        options.phase?.("executing")
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

/**
 * Bind a tool list into a per-run Toolset. The returned factory replaces
 * per-call dependency provisioning: call it once per run with the typed run
 * context.
 */
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
              return entries.filter((entry) => decisions[entry.meta.name] !== "deny")
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
              : ((await approvals(run, [request.name]))[request.name] ?? "approve")
          if (approvalDecision === "deny") {
            throw new ToolExecutionError(
              options.refusal?.(request.name, "denied") ??
                `Tool denied by settings: ${request.name}`,
              { preview: "Not allowed here", retryable: false }
            )
          }
          return applyTruncation(
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
        } catch (cause) {
          if (cause instanceof PauseRequested || cause instanceof ToolExecutionError) throw cause
          throw onExecuteError(cause, request)
        }
      }
    }
  }
}
