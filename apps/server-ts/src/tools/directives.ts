import type { ServerRunContext } from "./run-context.js"
import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import { createTwoFilesPatch } from "diff"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { rulesPage } from "../context/global-instructions.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../wiki/authority.js"
import { RULES_PAGE_PATH } from "../wiki/code-owned-pages.js"
import { WIKI_ERROR_REASON, type WikiError } from "../wiki/errors.js"
import { reviseWikiPage } from "../wiki/page.js"
import { Wiki } from "../wiki/service.js"
import { appliedReceipt } from "./call-receipt.js"
import { toolFailure, toolFault } from "./tool-failure.js"
import { requireOwnerTurn } from "./owner-turn.js"

const MAX_DIFF_BYTES = 64 * 1024
const EmptyParametersSchema = Schema.Record(Schema.String, Schema.Never)
const ReplaceParametersSchema = Schema.Struct({
  directives: Schema.Trim.pipe(
    Schema.annotateEncoded({
      description: `The complete desired global instructions as Markdown. This replaces the whole ${RULES_PAGE_PATH}.`
    })
  )
})

const changedSinceRead = (): ToolExecutionError =>
  toolFailure(
    {
      reason: "conflict",
      message:
        "Global instructions changed after they were read. Call directives_get, recompute the full replacement, and retry."
    },
    "Instructions changed"
  )

const failure = (error: WikiError): ToolExecutionError =>
  error.reason === WIKI_ERROR_REASON.conflict
    ? changedSinceRead()
    : toolFailure(error, "Instructions unavailable")

const readFirst = () =>
  new ToolExecutionError(
    "Read the current instructions before replacing them. Call directives_get, then retry.",
    { preview: "Read instructions first", retryable: true }
  )

const approvalDiff = (before: string, after: string): string => {
  const diff = createTwoFilesPatch(
    RULES_PAGE_PATH,
    RULES_PAGE_PATH,
    before,
    after,
    "before",
    "after",
    { context: 3 }
  )
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) {
    throw new ToolExecutionError(
      "The complete instructions diff is too large to review safely. Submit a smaller replacement.",
      { preview: "Instructions diff too large", retryable: false }
    )
  }
  return diff
}

const OUTCOMES = {
  unchanged: {
    result: "Global instructions already had this content; nothing changed.",
    preview: "Instructions unchanged"
  },
  cleared: { result: "Global instructions cleared.", preview: "Instructions cleared" },
  replaced: { result: "Global instructions replaced.", preview: "Instructions replaced" }
} as const

const storedBody = (content: string): string => (content === "" ? "" : `${content}\n`)

const makeDirectivesTools = ({
  wiki,
  sessions
}: {
  readonly wiki: Wiki["Service"]
  readonly sessions: SessionQueries["Service"]
}): ReadonlyArray<ServerTool> => {
  const readRules = async (signal: AbortSignal) => {
    const snapshot = await Effect.runPromise(wiki.snapshot().pipe(Effect.mapError(failure)), {
      signal
    })
    const record = rulesPage(snapshot)
    if (record === undefined || snapshot.head === null)
      throw toolFault(
        `Memory has no ${RULES_PAGE_PATH} page: Arden could not move the rules file into it at start. Ask the user to check the rules file, then restart Arden.`,
        "Instructions unavailable"
      )
    return { record, head: snapshot.head }
  }

  const readByOwner = async (ctx: ToolContext<ServerRunContext>) => {
    await requireOwnerTurn(
      sessions,
      ctx.run,
      ctx.signal,
      { kind: "directives" },
      {
        unverifiedBefore: "changing global instructions",
        notOwnerTurn: "Global instructions change only in the user's own turn, after their approval"
      }
    )
    const current = await readRules(ctx.signal)
    const observed = ctx.run.observations.observed(current.record.page.pageId)
    if (observed === undefined) throw readFirst()
    if (observed !== current.record.resource.versionId) throw changedSinceRead()
    return current
  }

  return [
    defineServerTool({
      name: "directives_get",
      summary: "Reads your standing instructions.",
      discovery: { group: "arden_settings" },
      description: `Read the user's global instructions, the ${RULES_PAGE_PATH} page at the root of Memory that applies to every chat, before replacing them.`,
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
        const { record } = await readRules(ctx.signal)
        ctx.run.observations.observe(record.page.pageId, record.resource.versionId)
        const content = record.page.body.trim()
        return {
          result: content === "" ? "No global instructions are set." : content,
          preview: content === "" ? "No instructions" : "Instructions loaded",
          data: { version: record.resource.versionId }
        }
      }
    }),
    defineServerTool({
      name: "directives_set",
      summary: "Changes your standing instructions.",
      discovery: { group: "arden_settings" },
      description: [
        `Replace the user's global instructions (their ${RULES_PAGE_PATH}) with the complete Markdown you pass; empty text clears them.`,
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
      approvalPrompt: async (input, ctx) => {
        const { record } = await readByOwner(ctx)
        return {
          preview: input.directives === "" ? "Clear instructions" : "Replace instructions",
          diff: approvalDiff(record.page.body.trim(), input.directives)
        }
      },
      execute: async (input, ctx, effects) => {
        const { record, head } = await readByOwner(ctx)
        const before = record.resource.versionId
        const changed = record.page.body.trim() !== input.directives
        let after = before
        let outcome: keyof typeof OUTCOMES = "unchanged"
        if (changed) {
          const content = await Effect.runPromise(
            reviseWikiPage(record.page, { body: storedBody(input.directives) }).pipe(
              Effect.mapError((cause) => toolFault(cause.message, "Instructions unavailable"))
            ),
            { signal: ctx.signal }
          )
          const [page] = await Effect.runPromise(
            wiki
              .update({
                edits: [{ pageId: record.page.pageId, content, expectedVersion: before }],
                expectedHead: head,
                authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
                commit: {
                  actor: "user:chat",
                  origin: { kind: "rules", sessionId: ctx.run.sessionId },
                  reason: "change the standing rules in a chat"
                }
              })
              .pipe(Effect.mapError(failure)),
            { signal: ctx.signal }
          )
          after = page.version
          outcome = input.directives === "" ? "cleared" : "replaced"
          effects.applied()
        } else effects.unchanged()
        ctx.run.observations.observe(record.page.pageId, after)
        return {
          ...OUTCOMES[outcome],
          data: { version: after },
          ...(changed
            ? {
                host: appliedReceipt(ctx, {
                  kind: "versioned_resource",
                  resourceRef: "resource:directives",
                  beforeVersion: before,
                  afterVersion: after,
                  domain: "resource",
                  title: "Instructions"
                })
              }
            : {})
        }
      }
    })
  ]
}

export const directivesTools = Effect.gen(function* () {
  return makeDirectivesTools({ wiki: yield* Wiki, sessions: yield* SessionQueries })
})
