import type { ServerRunContext } from "./run-context.js"
import { boundary } from "../execution/decide.js"
import { refusalError } from "./refusal.js"
import { ToolExecutionError } from "@arden-hq/loop"
import { createTwoFilesPatch } from "diff"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { GlobalInstructions, GlobalInstructionsError } from "../context/global-instructions.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { appliedReceipt } from "./call-receipt.js"
import { toolFailure } from "./tool-failure.js"

const DIRECTIVES_RESOURCE_ID = "directives"
const MAX_DIFF_BYTES = 64 * 1024
const EmptyParametersSchema = Schema.Record(Schema.String, Schema.Never)
const ReplaceParametersSchema = Schema.Struct({
  directives: Schema.Trim.check(Schema.isMaxLength(120_000)).pipe(
    Schema.annotateEncoded({
      description:
        "The complete desired global instructions as Markdown. This replaces the whole AGENTS.md."
    })
  )
})

const FAILURE_PREVIEWS = {
  invalid: "Invalid instructions",
  conflict: "Instructions changed",
  storage: "Instructions unavailable"
} as const satisfies Record<GlobalInstructionsError["reason"], string>

const failure = (error: GlobalInstructionsError): ToolExecutionError =>
  toolFailure(
    error.reason === "conflict"
      ? {
          reason: error.reason,
          message: `${error.message}. Call directives_get, recompute the full replacement, and retry.`
        }
      : error,
    FAILURE_PREVIEWS[error.reason]
  )

const approvalDiff = (before: string, after: string): string => {
  const diff = createTwoFilesPatch("AGENTS.md", "AGENTS.md", before, after, "before", "after", {
    context: 3
  })
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) {
    throw new ToolExecutionError(
      "The complete instructions diff is too large to review safely. Submit a smaller replacement.",
      { preview: "Instructions diff too large", retryable: false }
    )
  }
  return diff
}

const approvalVersion = (ctx: {
  readonly approval?: { readonly data?: Readonly<Record<string, unknown>> }
}): string | null => {
  const value = ctx.approval?.data?.expected_version
  if (value === undefined) return null
  if (typeof value !== "string") {
    throw new ToolExecutionError("The approved instructions revision is invalid", {
      preview: "Approval mismatch",
      retryable: false
    })
  }
  return value
}

const requireInteractiveSession = async (
  sessions: SessionQueries["Service"],
  run: ServerRunContext,
  signal: AbortSignal
): Promise<void> => {
  const sessionId = run.sessionId
  const header = await Effect.runPromise(
    sessions
      .loadHistoryHeader(sessionId)
      .pipe(
        Effect.mapError(
          () =>
            new ToolExecutionError(
              "The current Session could not be verified before changing global instructions.",
              { preview: "Session unavailable", retryable: true }
            )
        )
      ),
    { signal }
  )
  if (header === null)
    throw new ToolExecutionError(
      "The current Session could not be verified before changing global instructions.",
      { preview: "Session unavailable", retryable: false }
    )
  const verdict = boundary(run.authority, { kind: "directives" })
  if (verdict.kind !== "allow")
    throw refusalError({
      what: "Global instructions change only in the user's own turn, after their approval",
      rule: "boundary",
      instead: verdict.kind === "deny" ? verdict.instead : []
    })
}

const makeDirectivesTools = ({
  instructions,
  sessions
}: {
  readonly instructions: GlobalInstructions["Service"]
  readonly sessions: SessionQueries["Service"]
}): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "directives_get",
    description:
      "Read the user's global instructions, the AGENTS.md in Arden's data folder that applies to every chat, before replacing them.",
    parameters: Schema.toStandardSchemaV1(EmptyParametersSchema),
    metadata: {
      effect: "none",
      display_name: "Get Instructions",
      kind: "tool",
      action: "read",
      approval_preview: "Read your standing instructions.",
      source: "_directives",
      changes_state: false,
      concurrency_group: "directives",
      destructive: null
    },
    execute: async (_input, ctx) => {
      const snapshot = await Effect.runPromise(instructions.read().pipe(Effect.mapError(failure)), {
        signal: ctx.signal
      })
      ctx.run.observations.observe(DIRECTIVES_RESOURCE_ID, snapshot.version)
      return {
        result: snapshot.content ?? "No global instructions are set.",
        preview: snapshot.content === undefined ? "No instructions" : "Instructions loaded",
        data: { bytes: snapshot.bytes, version: snapshot.version }
      }
    }
  }),
  defineServerTool({
    name: "directives_set",
    description: [
      "Replace the user's global instructions (their AGENTS.md) from an ordinary Chat only.",
      "Pass the complete desired Markdown and call directives_get first. Asks by default."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ReplaceParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Set Instructions",
      standing: "always",
      kind: "tool",
      action: "write",
      approval_preview: "Change your standing instructions.",
      source: "_directives",
      changes_state: true,
      concurrency_group: "directives",
      destructive: true,
      default_approval: "ask",
      idempotent: true,
      target: "reported"
    },
    approvalPrompt: async (input, ctx) => {
      await requireInteractiveSession(sessions, ctx.run, ctx.signal)
      const current = await Effect.runPromise(instructions.read().pipe(Effect.mapError(failure)), {
        signal: ctx.signal
      })
      const observed = ctx.run.observations.observed(DIRECTIVES_RESOURCE_ID)
      if (current.version !== "absent" && observed === undefined) {
        throw new ToolExecutionError(
          "Read the current instructions before replacing them. Call directives_get, then retry.",
          { preview: "Read instructions first", retryable: true }
        )
      }
      if (observed !== undefined && observed !== current.version) {
        throw failure(
          new GlobalInstructionsError({
            operation: "replace",
            reason: "conflict",
            message: "Global instructions changed after they were read"
          })
        )
      }
      return {
        preview: input.directives.trim() === "" ? "Clear instructions" : "Replace instructions",
        diff: approvalDiff(current.content ?? "", input.directives.trim()),
        data: { expected_version: current.version }
      }
    },
    execute: async (input, ctx, effects) => {
      await requireInteractiveSession(sessions, ctx.run, ctx.signal)
      const current = await Effect.runPromise(instructions.read().pipe(Effect.mapError(failure)), {
        signal: ctx.signal
      })
      const observed = ctx.run.observations.observed(DIRECTIVES_RESOURCE_ID)
      const approved = approvalVersion(ctx)
      const expected = approved ?? observed ?? (current.version === "absent" ? "absent" : null)
      if (expected === null) {
        throw new ToolExecutionError(
          "Read the current instructions before replacing them. Call directives_get, then retry.",
          { preview: "Read instructions first", retryable: true }
        )
      }
      const snapshot = await Effect.runPromise(
        instructions
          .replace({
            content: input.directives,
            expectedVersion: expected
          })
          .pipe(Effect.mapError(failure)),
        { signal: ctx.signal }
      )
      const changed = snapshot.version !== expected
      if (changed) effects.applied()
      else effects.unchanged()
      ctx.run.observations.observe(DIRECTIVES_RESOURCE_ID, snapshot.version)
      return {
        result:
          snapshot.content === undefined
            ? "Global instructions cleared."
            : "Global instructions replaced.",
        preview: snapshot.content === undefined ? "Instructions cleared" : "Instructions replaced",
        data: { bytes: snapshot.bytes, version: snapshot.version },
        ...(changed
          ? {
              host: appliedReceipt(ctx, {
                kind: "versioned_resource",
                resourceRef: `resource:${DIRECTIVES_RESOURCE_ID}`,
                beforeVersion: expected,
                afterVersion: snapshot.version,
                domain: "resource",
                title: "Instructions"
              })
            }
          : {})
      }
    }
  })
]

export const directivesTools = Effect.gen(function* () {
  return makeDirectivesTools({
    instructions: yield* GlobalInstructions,
    sessions: yield* SessionQueries
  })
})
