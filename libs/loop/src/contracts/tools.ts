import type {
  ChatMessage,
  ContentBlock,
  JsonObject,
  MaybePromise,
  Metadata,
  ToolCall
} from "./messages.js"

export interface ToolMeta {
  /**
   * Start in the background at once. Any other call that can run in the
   * background moves there when it outlives the foreground budget.
   */
  readonly background?: boolean
  /** Returns a handle to its own long-running job; never also run in the background. */
  readonly detached?: boolean
  readonly name: string
  /** Executes upstream rather than through the local toolset. */
  readonly hosted?: boolean
  readonly changes_state?: boolean
  readonly concurrency_group?: string | null
  readonly ends_turn?: EndsTurn
  readonly deferred?: boolean
  /** The namespace a deferred tool is found and loaded under. */
  readonly group?: string
  /** Tools that produce this tool's required inputs; search loads them with it. */
  readonly input_sources?: ReadonlyArray<ToolInputSource>
  readonly host?: Metadata
}

/**
 * Whether a successful call ends the run with its result as the final text:
 * always, or only when one top-level argument
 * has the given value (one tool whose `event: "blocked"` is a verdict on the whole run, while its other
 * events let the run go on).
 */
export type EndsTurn = boolean | { readonly argument: string; readonly equals: string }

/** Whether this call, with these arguments, ends the run. */
export const callEndsTurn = (
  meta: { readonly ends_turn?: EndsTurn } | undefined,
  args: Readonly<Record<string, unknown>>
): boolean => {
  const rule = meta?.ends_turn
  if (rule === undefined || typeof rule === "boolean") return rule === true
  return args[rule.argument] === rule.equals
}

/** Whether some call of this tool may end the run. */
export const mayEndTurn = (meta: { readonly ends_turn?: EndsTurn } | undefined): boolean =>
  meta?.ends_turn !== undefined && meta.ends_turn !== false

/**
 * Whether calls of this tool can run in the background: hosted tools run
 * upstream, turn-ending ones must stand alone and last, and detached ones
 * already return their own job handle.
 */
export const canRunInBackground = (
  meta: Pick<ToolMeta, "hosted" | "detached" | "ends_turn"> | undefined
): boolean => meta?.hosted !== true && meta?.detached !== true && !mayEndTurn(meta)

/** One required input and the tools that can produce its value. */
export interface ToolInputSource {
  readonly input: string
  readonly tools: ReadonlyArray<string>
}

/** One tool as a toolset advertises it; `meta.name` names it. */
export interface ToolEntry {
  readonly description: string
  readonly parameters: JsonSchema
  readonly meta: ToolMeta
}

/** Standard JSON Schema; each provider maps it to its own wire dialect. */
export type JsonSchema = Readonly<Record<string, unknown>>

/** The provider-neutral declaration of one tool in a model request. */
export interface ToolDeclaration {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
  /** Executes upstream; the provider maps it to its own hosted tool. */
  readonly hosted?: boolean
  /** The provider may deliver this call's output after the response ends. */
  readonly async?: boolean
  /** The namespace a deferred tool loads under. */
  readonly group?: string
}

/**
 * A request's client-side tool search. The loop builds it; a provider with
 * native client-executed search declares its description and parameters and
 * answers the model's search calls through `search`.
 */
export interface ToolSearch {
  /** Model-facing description, including the stable catalog listing. */
  readonly description: string
  readonly parameters: JsonSchema
  readonly search: (input: { readonly query: string; readonly limit?: number }) => ToolSearchResult
  /** Exact declarations for names, without companions: the same names always render the same. */
  readonly lookup: (names: ReadonlyArray<string>) => ReadonlyArray<ToolDeclaration>
}

export interface ToolSearchResult {
  /** Selected primary declarations, then unloaded companions outside the primary-match limit. */
  readonly tools: ReadonlyArray<ToolDeclaration>
  /** Selected primary matches within the limit, including ones already loaded. */
  readonly matched: ReadonlyArray<string>
}

export interface ToolResult {
  readonly content: string
  readonly preview: string
  readonly is_error?: boolean
  readonly retryable?: boolean | null
  readonly data?: JsonObject | null
  readonly message_extras?: Metadata
  readonly host?: Metadata
  readonly model_content?: ReadonlyArray<ContentBlock>
}

export type ToolArgumentErrorCode = "invalid_tool_arguments" | "unavailable_tool"

export interface ToolArgumentError {
  readonly code: ToolArgumentErrorCode
  readonly message: string
}

export interface PendingToolCall {
  readonly toolCall: ToolCall
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly displayTitle?: string
  readonly argumentError?: ToolArgumentError
}

/** Host-confirmed approval for this exact tool call. */
export interface ToolApprovalContext {
  readonly approved: true
  /**
   * A reviewer model approved this call on the person's behalf, judging the
   * card they would have seen; absent, the person approved it themselves.
   */
  readonly reviewer?: true
  readonly feedback: string | null
  /** The user also saved a standing rule with this approval. */
  readonly grantStanding?: boolean
  /** Host-private, durable data captured when this exact call was reviewed. */
  readonly data?: JsonObject
  /** The person changed this call's arguments while approving it. */
  readonly edited?: ToolApprovalEdits
  /**
   * The person chose the tool's own alternative on the card instead of the
   * call as asked: `draft` keeps a message as a draft and never sends it. The
   * host runs only tools that offer it; the call settles with that result.
   */
  readonly alternative?: "draft"
}

/**
 * Arguments a person edited on the approval card. The call runs with
 * `arguments`, validated by the tool's own schema like any call; `requested`
 * is what the model asked for, so the tool can tell it what changed.
 */
export interface ToolApprovalEdits {
  readonly requested: JsonObject
  readonly arguments: JsonObject
}

/** One live progress update pushed by a running tool. */
export interface ToolProgressUpdate {
  readonly message: string
  readonly data?: Readonly<Record<string, unknown>>
}

export interface ToolCallRequest {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly toolCallId: string
  readonly approval?: ToolApprovalContext
  readonly signal?: AbortSignal
  /** Read-only view of the canonical history at call time. */
  readonly messages?: ReadonlyArray<ChatMessage>
  /** Fire-and-forget progress channel bound to this call's identity. */
  readonly emit?: (update: ToolProgressUpdate) => void
  /** Recheck after host approval/locks, immediately before an unstarted effect. */
  readonly beforeExecute?: () => Promise<ToolResult | undefined>
  /**
   * The toolset reports where the call is: `waiting` before its effect (an
   * approval gate, a host lock), `executing` once its effect begins. The
   * loop's foreground budget counts from `executing`, or from `execute` for a
   * toolset that never reports.
   */
  readonly phase?: (phase: ToolPhase) => void
  /**
   * Resolves when the loop moves this still-running call to the background:
   * the model has a receipt and the call's result arrives later. A host that
   * holds its own state-change lock releases it here, as the loop does.
   */
  readonly backgrounded?: Promise<void>
}

export type ToolPhase = "waiting" | "executing"

/** A background call a paused run left running, held by the host until claimed or stopped. */
export interface HeldToolCall {
  readonly toolCallId: string
  /** Its outcome; undefined when it settles without one (it paused or was stopped). */
  readonly result: Promise<ToolResult | undefined>
  /** Aborts the call (and the others it was started beside). */
  readonly stop: () => void
}

/**
 * A host's opt-in display-title argument: every tool schema advertises it,
 * the loop strips it before validation, sanitizes it (control characters to
 * spaces, whitespace collapsed, capped at `maxLength` code points) and
 * persists it as `ToolCall.display_title`.
 */
export interface ToolDisplayTitle {
  readonly argument: string
  readonly maxLength: number
}

export interface Toolset {
  /** The display-title argument this toolset's schemas advertise, if any. */
  readonly displayTitle?: ToolDisplayTitle
  readonly entries: () => MaybePromise<ReadonlyArray<ToolEntry>>
  /** Resolve metadata for a tool omitted from the advertised catalog. */
  readonly metadata?: (name: string) => MaybePromise<ToolMeta | undefined>
  readonly loadedNames: () => MaybePromise<ReadonlySet<string>>
  readonly load: (names: ReadonlySet<string>) => MaybePromise<void>
  readonly seedLoadedNames?: (names: ReadonlySet<string>) => MaybePromise<void>
  readonly execute: (request: ToolCallRequest) => MaybePromise<ToolResult>
  /** Settle an unstarted admission refusal through the host's durable owner. */
  readonly settleRefusal?: (
    request: ToolCallRequest,
    result: ToolResult
  ) => MaybePromise<ToolResult>
  /**
   * Pure harness-owned decoration applied to every model-visible outcome,
   * including validation failures, durable recovery, and batch rejection.
   */
  readonly decorateResult?: (request: ToolCallRequest, result: ToolResult) => ToolResult
}

export type ToolCallNext = (request: ToolCallRequest) => MaybePromise<ToolResult>
export type ToolCallMiddleware = (
  request: ToolCallRequest,
  next: ToolCallNext
) => MaybePromise<ToolResult>
