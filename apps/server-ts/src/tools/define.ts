import {
  createTool,
  PauseRequested,
  ToolExecutionError,
  toToolFailure,
  type StandardSchemaV1,
  type Tool,
  type ToolApprovalPrompt,
  type ToolContext,
  type ToolDefinition,
  type ToolResultOutput
} from "@arden-hq/loop"
import type { ApprovalPresentation } from "@arden-hq/protocol/chat"
import { ToolDisplaySchema } from "@arden-hq/protocol/effect/tools"
import { Effect, Option, Schema } from "effect"

import { LocalTargetSchema } from "../execution/local-target.js"
import type { ServerRunContext } from "./run-context.js"
import {
  executeEdited,
  makeApprovalEditor,
  type ApprovalEditor,
  type ServerApprovalEdits
} from "./approval-edits.js"
import { SCOPE_KEYS } from "../execution/policy.js"
import type { CallImpact } from "../execution/impact.js"
import {
  makeCallEffectLedger,
  MAX_CALL_TARGETS,
  ToolEffectSchema,
  type CallEffectLedger,
  type CallEffects,
  type EffectTarget
} from "../execution/tool-effect.js"
import { mutationReceiptHost, readMutationReceipt } from "../persistence/tools/mutation-receipt.js"

const ServerToolMetadataInputSchema = Schema.Struct({
  display_name: Schema.String,
  kind: Schema.String,
  action: Schema.Literals(["read", "write", "execute"]),
  source: Schema.String,
  changes_state: Schema.Boolean,
  concurrency_group: Schema.NullOr(Schema.String),
  destructive: Schema.NullOr(Schema.Boolean),
  approval_preview: Schema.optionalKey(Schema.String),
  default_approval: Schema.optionalKey(Schema.Literals(["approve", "ask"])),
  policy_scope: Schema.optionalKey(Schema.Literals(["internal", "external"])),
  permissions: Schema.optionalKey(Schema.Array(Schema.String)),
  open_world: Schema.optionalKey(Schema.Boolean),
  idempotent: Schema.optionalKey(Schema.Boolean),
  internal_catalog: Schema.optionalKey(Schema.Boolean),
  invocation_only: Schema.optionalKey(Schema.Literal(true)),
  scopes: Schema.optionalKey(Schema.Array(Schema.Literals(SCOPE_KEYS))),
  actor: Schema.optionalKey(Schema.Literal("user_automation")),
  outcome: Schema.optionalKey(Schema.Boolean),
  effect: ToolEffectSchema,
  unattended_scope: Schema.optionalKey(Schema.Literals(SCOPE_KEYS)),
  private_scope: Schema.optionalKey(Schema.Literals(SCOPE_KEYS)),
  code_mode: Schema.optionalKey(Schema.Boolean),
  read_only_mode: Schema.optionalKey(Schema.Literal("self_gated")),
  local_target: Schema.optionalKey(LocalTargetSchema),
  presentation: Schema.optionalKey(Schema.Literals(["work", "conversation", "status"])),
  display: Schema.optionalKey(ToolDisplaySchema),
  background: Schema.optionalKey(Schema.Boolean),
  detached: Schema.optionalKey(Schema.Boolean),
  hosted: Schema.optionalKey(Schema.Boolean),
  ends_turn: Schema.optionalKey(
    Schema.Union([
      Schema.Boolean,
      Schema.Struct({ argument: Schema.String, equals: Schema.String })
    ])
  ),
  approval_bypass: Schema.optionalKey(Schema.Boolean),
  requirement: Schema.optionalKey(Schema.Literal("boundary")),
  always_ask: Schema.optionalKey(Schema.Boolean),
  refuse_unattended: Schema.optionalKey(Schema.Boolean),
  standing: Schema.optionalKey(Schema.Literals(["always", "requirement"])),
  target: Schema.optionalKey(Schema.Literal("reported"))
}).check(
  Schema.makeFilter((metadata) =>
    metadata.invocation_only === true &&
    (!metadata.internal_catalog || metadata.changes_state || metadata.effect !== "none")
      ? [
          {
            path: ["invocation_only"],
            issue: "requires an internal protocol with no external effect"
          }
        ]
      : []
  )
)
export type ServerToolMetadataInput = typeof ServerToolMetadataInputSchema.Type
// Excess keys are an error at runtime too: metadata spread from a shared
// constant or read from JSON escapes the compiler's excess-property check.
const decodeServerToolMetadataInput = Schema.decodeUnknownOption(ServerToolMetadataInputSchema, {
  onExcessProperty: "error"
})

type DefaultedKey =
  | "default_approval"
  | "policy_scope"
  | "permissions"
  | "open_world"
  | "idempotent"
  | "internal_catalog"
  | "scopes"
  | "outcome"
  | "code_mode"

export type ServerToolMetadata = Omit<ServerToolMetadataInput, DefaultedKey> &
  Required<Pick<ServerToolMetadataInput, DefaultedKey>>

export type ServerApprovalPrompt = ToolApprovalPrompt<ApprovalPresentation>

export interface ServerToolDefinition<S extends StandardSchemaV1> extends Omit<
  ToolDefinition<S, ServerRunContext, ServerToolMetadataInput>,
  "approvalPrompt" | "approvalRequirement" | "execute"
> {
  readonly execute: (
    input: StandardSchemaV1.InferOutput<S>,
    ctx: ToolContext<ServerRunContext>,
    effects: CallEffects
  ) => Promise<ToolResultOutput | string>
  readonly approvalPrompt?: (
    input: StandardSchemaV1.InferOutput<S>,
    ctx: ToolContext<ServerRunContext>
  ) => ServerApprovalPrompt | Promise<ServerApprovalPrompt>
  readonly approvalRequirement?: (
    input: StandardSchemaV1.InferOutput<S>,
    ctx: ToolContext<ServerRunContext>
  ) => ServerApprovalPrompt | undefined | Promise<ServerApprovalPrompt | undefined>
  readonly approvalEdits?: ServerApprovalEdits<StandardSchemaV1.InferOutput<S>>
  readonly approvalDraft?: ServerToolDefinition<S>["execute"]
  readonly shellCommand?: (
    input: StandardSchemaV1.InferOutput<S>,
    ctx: ToolContext<ServerRunContext>
  ) => Promise<ShellCommand | undefined>
  readonly impact?: (
    input: StandardSchemaV1.InferOutput<S>,
    ctx: ToolContext<ServerRunContext>
  ) => CallImpact
  readonly site?: (input: StandardSchemaV1.InferOutput<S>) => string
}

export interface ShellCommand {
  readonly command: string
  readonly cwd: string | undefined
}

type ShellCommandOf = (
  input: unknown,
  ctx: ToolContext<ServerRunContext>
) => Promise<ShellCommand | undefined>

const SHELL_COMMANDS = new WeakMap<object, ShellCommandOf>()

type ImpactOf = (input: unknown, ctx: ToolContext<ServerRunContext>) => CallImpact

const IMPACTS = new WeakMap<object, ImpactOf>()

type SiteOf = (input: unknown) => string

const SITES = new WeakMap<object, SiteOf>()

export const siteOf = (definition: object): SiteOf | undefined => SITES.get(definition)

export const impactOf = (definition: object): ImpactOf | undefined => IMPACTS.get(definition)

export const shellCommandOf = (definition: object): ShellCommandOf | undefined =>
  SHELL_COMMANDS.get(definition)

export interface ServerTool extends Tool<ServerRunContext, ServerToolMetadataInput> {
  readonly meta: ServerToolMetadata
  readonly approvalEditor?: ApprovalEditor
  readonly offersDraft?: true
}

export const defineServerTool = <S extends StandardSchemaV1>(
  definition: ServerToolDefinition<S>
): ServerTool => {
  const decoded = decodeServerToolMetadataInput(definition.metadata)
  if (Option.isNone(decoded)) {
    throw new Error(`Invalid server metadata for tool ${definition.name}`)
  }
  const metadata = decoded.value
  if (metadata.always_ask === true && definition.approvalPrompt === undefined) {
    throw new Error(`Tool ${definition.name} always asks but has no approvalPrompt`)
  }
  if (metadata.outcome === true && metadata.effect !== "run_record") {
    throw new Error(`Outcome tool ${definition.name} must declare effect "run_record"`)
  }
  if (metadata.changes_state && metadata.effect === "none") {
    throw new Error(`Tool ${definition.name} changes state but declares no effect`)
  }
  if (metadata.changes_state && metadata.target === undefined) {
    throw new Error(`Tool ${definition.name} changes state but does not declare its target`)
  }
  const edits = definition.approvalEdits
  const draft = definition.approvalDraft
  const tool = createTool({
    ...definition,
    execute: (input, ctx) => {
      const named = new Set<string>()
      const linked = new Map<string, EffectTarget>()
      const ledger = makeCallEffectLedger((target, origin, answered) => {
        named.add(JSON.stringify([target.source, target.objectId]))
        if (target.href !== undefined && target.title !== undefined) linked.set(target.href, target)
        if (!answered && named.size > MAX_CALL_TARGETS)
          return Promise.reject(
            new ToolExecutionError(
              `One call can change at most ${MAX_CALL_TARGETS} objects; split it into smaller calls.`,
              { preview: "Not sent", retryable: false }
            )
          )
        const stored = ctx.run
          .declareEffectTarget({ toolCallId: ctx.toolCallId, target, origin })
          .catch((cause: unknown) => {
            Effect.runSync(
              Effect.logWarning("Could not record a call's target", {
                tool: definition.name,
                toolCallId: ctx.toolCallId,
                origin,
                cause
              })
            )
            throw cause
          })
        if (answered) return stored.catch(() => undefined)
        return stored.catch(() => {
          throw new ToolExecutionError("Could not record what this call is about to change.", {
            preview: "Not sent",
            retryable: true
          })
        })
      })
      const run = (
        runInput: StandardSchemaV1.InferOutput<S>,
        runCtx: ToolContext<ServerRunContext>
      ) => {
        if (runCtx.approval?.alternative !== "draft") {
          return definition.execute(runInput, runCtx, ledger)
        }
        if (draft === undefined) {
          throw new ToolExecutionError("This call cannot be saved as a draft.", {
            preview: "No draft",
            retryable: false
          })
        }
        return draft(runInput, runCtx, ledger)
      }
      const executed = executeEdited({ ...definition, execute: run }, input, ctx)
      return metadata.changes_state ? withReceipt(executed, ledger, ctx, linked) : executed
    }
  })
  if (definition.shellCommand !== undefined)
    SHELL_COMMANDS.set(tool.definition, definition.shellCommand)
  if (definition.impact !== undefined) IMPACTS.set(tool.definition, definition.impact)
  if (definition.site !== undefined) SITES.set(tool.definition, definition.site)
  return {
    ...tool,
    ...(edits === undefined
      ? {}
      : { approvalEditor: makeApprovalEditor(definition.parameters, edits) }),
    ...(draft === undefined ? {} : { offersDraft: true as const }),
    meta: {
      ...metadata,
      default_approval: metadata.default_approval ?? "approve",
      policy_scope: metadata.policy_scope ?? "internal",
      permissions: metadata.permissions ?? ["session"],
      open_world: metadata.open_world ?? false,
      idempotent: metadata.idempotent ?? true,
      internal_catalog: metadata.internal_catalog ?? false,
      scopes: metadata.scopes ?? [],
      outcome: metadata.outcome ?? false,
      code_mode: metadata.code_mode ?? true
    }
  }
}

const withReceipt = async (
  executed: Promise<ToolResultOutput | string>,
  ledger: CallEffectLedger,
  ctx: ToolContext<ServerRunContext>,
  linked: ReadonlyMap<string, EffectTarget>
): Promise<ToolResultOutput> => {
  const identity = { runId: ctx.run.runId, toolCallId: ctx.toolCallId }
  const receipt = (settled: "succeeded" | "threw") =>
    mutationReceiptHost({
      identity,
      outcome: ledger.outcome(settled).outcome,
      resource: { kind: "none" }
    })
  try {
    const output = await executed
    const original = typeof output === "string" ? { result: output } : output
    const sources = [...linked.entries()].slice(0, MAX_CALL_TARGETS).map(([href, target]) => ({
      provider: target.source,
      kind: "result",
      ref: href,
      title: target.title ?? href,
      href
    }))
    const value =
      sources.length === 0
        ? original
        : {
            ...original,
            result: `${original.result}\n\nResult links: ${JSON.stringify(sources)}`,
            data: {
              ...original.data,
              source_refs: [
                ...(Array.isArray(original.data?.source_refs) ? original.data.source_refs : []),
                ...sources
              ]
            },
            host: {
              ...original.host,
              source_refs: [
                ...(Array.isArray(original.host?.["source_refs"])
                  ? original.host["source_refs"]
                  : []),
                ...sources
              ]
            }
          }
    if (readMutationReceipt(value.host) !== undefined) return value
    return { ...value, host: { ...value.host, ...receipt("succeeded") } }
  } catch (cause) {
    if (cause instanceof PauseRequested || ctx.signal.aborted) throw cause
    const failure = toToolFailure(cause)
    if (failure instanceof PauseRequested) throw failure
    throw new ToolExecutionError(failure.message, {
      ...(failure.preview === undefined ? {} : { preview: failure.preview }),
      retryable: failure.retryable ?? (cause instanceof ToolExecutionError ? false : null),
      diagnosticRef: failure.diagnosticRef ?? `tool-call:${ctx.toolCallId}`,
      host: { ...failure.host, ...receipt("threw") }
    })
  }
}
