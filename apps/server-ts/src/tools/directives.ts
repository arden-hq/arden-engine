import type { ServerRunContext } from "./run-context.js"
import { boundary } from "../execution/decide.js"
import { refusalError } from "./refusal.js"
import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import { countOf, formatBytes } from "@arden-hq/std/count"
import { createTwoFilesPatch } from "diff"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { GlobalInstructions, GlobalInstructionsError } from "../context/global-instructions.js"
import type { InstructionChat, InstructionWriter } from "../persistence/instructions/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { appliedReceipt } from "./call-receipt.js"
import type { CallEffects } from "../execution/tool-effect.js"
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

const MAX_LISTED_VERSIONS = 100

const HistoryParametersSchema = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LISTED_VERSIONS }))
    .annotate({
      description: `Most versions to list, newest first, from 1 to ${MAX_LISTED_VERSIONS}. Defaults to 20.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(20)))
})

const RestoreParametersSchema = Schema.Struct({
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The version number directives_history lists."
  })
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

const directivesOutcome = (
  changed: boolean,
  cleared: boolean
): { readonly result: string; readonly preview: string } => {
  if (!changed)
    return {
      result: "Global instructions already had this content; nothing changed.",
      preview: "Instructions unchanged"
    }
  if (cleared) return { result: "Global instructions cleared.", preview: "Instructions cleared" }
  return { result: "Global instructions replaced.", preview: "Instructions replaced" }
}

const writerPhrase = (
  writer: InstructionWriter,
  chats: ReadonlyMap<string, string | undefined>
): string => {
  const chat = (writer: { readonly chat: InstructionChat | undefined }) =>
    (writer.chat === undefined ? undefined : chats.get(writer.chat.sessionId)) ??
    "a chat that no longer exists"
  switch (writer.kind) {
    case "seed":
      return "the rules as they were when this history began"
    case "outside":
      return "edited outside Arden, taken as yours"
    case "chat":
      return `changed in ${chat(writer)}`
    case "restore":
      return `version ${writer.from} restored in ${chat(writer)}`
  }
}

const chatOf = (writer: InstructionWriter): string | undefined =>
  writer.kind === "chat" || writer.kind === "restore" ? writer.chat?.sessionId : undefined

/** Approval and replacement shared by every tool that changes the rules, so each asks the same. */
const makeRulesChange = ({
  instructions,
  sessions
}: {
  readonly instructions: GlobalInstructions["Service"]
  readonly sessions: SessionQueries["Service"]
}) => {
  const readCurrent = (signal: AbortSignal) =>
    Effect.runPromise(instructions.read().pipe(Effect.mapError(failure)), { signal })

  const approval = async (content: string, ctx: ToolContext<ServerRunContext>) => {
    await requireInteractiveSession(sessions, ctx.run, ctx.signal)
    const current = await readCurrent(ctx.signal)
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
      preview: content.trim() === "" ? "Clear instructions" : "Replace instructions",
      diff: approvalDiff(current.content ?? "", content.trim())
    }
  }

  const apply = async (
    content: string,
    restoredFrom: number | undefined,
    ctx: ToolContext<ServerRunContext>,
    effects: CallEffects
  ) => {
    await requireInteractiveSession(sessions, ctx.run, ctx.signal)
    const current = await readCurrent(ctx.signal)
    const observed = ctx.run.observations.observed(DIRECTIVES_RESOURCE_ID)
    const expected = observed ?? (current.version === "absent" ? "absent" : null)
    if (expected === null) {
      throw new ToolExecutionError(
        "Read the current instructions before replacing them. Call directives_get, then retry.",
        { preview: "Read instructions first", retryable: true }
      )
    }
    const chat = { sessionId: ctx.run.sessionId, runId: ctx.run.runId }
    const snapshot = await Effect.runPromise(
      instructions
        .replace({
          content,
          expectedVersion: expected,
          writer:
            restoredFrom === undefined
              ? { kind: "chat", chat }
              : { kind: "restore", chat, from: restoredFrom }
        })
        .pipe(Effect.mapError(failure)),
      { signal: ctx.signal }
    )
    const changed = snapshot.version !== expected
    if (changed) effects.applied()
    else effects.unchanged()
    ctx.run.observations.observe(DIRECTIVES_RESOURCE_ID, snapshot.version)
    const outcome = directivesOutcome(changed, snapshot.content === undefined)
    return {
      ...outcome,
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

  return { approval, apply }
}

const makeDirectivesTools = ({
  instructions,
  sessions
}: {
  readonly instructions: GlobalInstructions["Service"]
  readonly sessions: SessionQueries["Service"]
}): ReadonlyArray<ServerTool> => {
  const change = makeRulesChange({ instructions, sessions })
  const storedVersion = async (version: number, signal: AbortSignal) => {
    const stored = await Effect.runPromise(
      instructions.version(version).pipe(Effect.mapError(failure)),
      { signal }
    )
    if (stored === undefined)
      throw new ToolExecutionError(
        `There is no version ${version} of the instructions. Call directives_history to list them.`,
        { preview: "No such version", retryable: false }
      )
    return stored
  }
  const chatLinks = async (sessionIds: ReadonlySet<string>, signal: AbortSignal) => {
    const links = new Map<string, string | undefined>()
    for (const sessionId of sessionIds) {
      const header = await Effect.runPromise(
        sessions.loadHistoryHeader(sessionId).pipe(Effect.orElseSucceed(() => null)),
        { signal }
      )
      links.set(
        sessionId,
        header === null ? undefined : `arden:session/${encodeURIComponent(header.publicRef)}`
      )
    }
    return links
  }

  return [
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
        const snapshot = await Effect.runPromise(
          instructions.read().pipe(Effect.mapError(failure)),
          {
            signal: ctx.signal
          }
        )
        ctx.run.observations.observe(DIRECTIVES_RESOURCE_ID, snapshot.version)
        return {
          result: snapshot.content ?? "No global instructions are set.",
          preview: snapshot.content === undefined ? "No instructions" : "Instructions loaded",
          data: { bytes: snapshot.bytes, version: snapshot.version }
        }
      }
    }),
    defineServerTool({
      name: "directives_history",
      description:
        "List the saved versions of the user's global instructions, newest first, with who changed them and when. Pass a version to directives_restore to bring it back.",
      parameters: Schema.toStandardSchemaV1(HistoryParametersSchema),
      metadata: {
        effect: "none",
        display_name: "Instructions History",
        kind: "tool",
        action: "read",
        approval_preview: "List the versions of your standing instructions.",
        source: "_directives",
        changes_state: false,
        concurrency_group: "directives",
        destructive: null
      },
      execute: async (input, ctx) => {
        const current = await Effect.runPromise(
          instructions.read().pipe(Effect.mapError(failure)),
          { signal: ctx.signal }
        )
        const { versions, total } = await Effect.runPromise(
          instructions.versions({ limit: input.limit }).pipe(Effect.mapError(failure)),
          { signal: ctx.signal }
        )
        ctx.run.observations.observe(DIRECTIVES_RESOURCE_ID, current.version)
        const chats = await chatLinks(
          new Set(versions.flatMap((version) => chatOf(version.writer) ?? [])),
          ctx.signal
        )
        const older = total - versions.length
        const lines = versions.map(
          (version) =>
            `- version ${version.version}${version.digest === current.version ? " (current)" : ""} — ${version.recordedAt} — ${writerPhrase(version.writer, chats)} — ${formatBytes(Buffer.byteLength(version.content, "utf8"))}`
        )
        return {
          result:
            versions.length === 0
              ? "No versions of the instructions are saved yet."
              : `Instructions history\n${lines.join("\n")}${older > 0 ? `\n${older} older versions are not shown; retry with a larger limit.` : ""}`,
          preview: countOf(versions.length, "instructions version"),
          data: {
            total,
            versions: versions.map((version) => ({
              version: version.version,
              current: version.digest === current.version,
              recorded_at: version.recordedAt,
              writer: version.writer.kind,
              chat: (() => {
                const sessionId = chatOf(version.writer)
                return sessionId === undefined ? null : (chats.get(sessionId) ?? null)
              })(),
              restored_from: version.writer.kind === "restore" ? version.writer.from : null
            }))
          }
        }
      }
    }),
    defineServerTool({
      name: "directives_set",
      description: [
        "Replace the user's global instructions (their AGENTS.md) with the complete Markdown you pass; empty text clears them.",
        "Call directives_get first; the change fails if they changed since that read.",
        "Works only during the user's own turn in a chat; automations and other agents are refused. Asks by default."
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
      approvalPrompt: (input, ctx) => change.approval(input.directives, ctx),
      execute: (input, ctx, effects) => change.apply(input.directives, undefined, ctx, effects)
    }),
    defineServerTool({
      name: "directives_restore",
      description: [
        "Bring back one saved version of the user's global instructions, as directives_history lists it; this undoes later changes.",
        "Works only during the user's own turn in a chat. Asks by default."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(RestoreParametersSchema),
      metadata: {
        effect: "arden_db",
        display_name: "Restore Instructions",
        standing: "always",
        kind: "tool",
        action: "write",
        approval_preview: "Bring back an earlier version of your standing instructions.",
        source: "_directives",
        changes_state: true,
        concurrency_group: "directives",
        destructive: true,
        default_approval: "ask",
        idempotent: true,
        target: "reported"
      },
      approvalPrompt: async (input, ctx) =>
        change.approval((await storedVersion(input.version, ctx.signal)).content, ctx),
      execute: async (input, ctx, effects) =>
        change.apply(
          (await storedVersion(input.version, ctx.signal)).content,
          input.version,
          ctx,
          effects
        )
    })
  ]
}

export const directivesTools = Effect.gen(function* () {
  return makeDirectivesTools({
    instructions: yield* GlobalInstructions,
    sessions: yield* SessionQueries
  })
})
