import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import { countOf } from "@arden-hq/std/count"
import { clipLine } from "@arden-hq/std/text"
import { Effect, Schema } from "effect"

import { SessionQueries } from "../persistence/sessions/queries.js"
import { WIKI_ERROR_REASON, WIKI_OPERATION, type WikiError } from "../wiki/errors.js"
import type { RetractionChange } from "../wiki/forgotten.js"
import { claimKey, MAX_CLAIM_CHARS } from "../wiki/retraction.js"
import { Wiki } from "../wiki/service.js"
import { boundedDiff } from "./bounded-diff.js"
import { chatLinkOf } from "./call-receipt.js"
import { defineServerTool, type ServerTool } from "./define.js"
import { requireOwnerTurn } from "./owner-turn.js"
import type { ServerRunContext } from "./run-context.js"
import { wikiFailure } from "./wiki-access.js"
import { memoryLocation } from "./wiki-identity.js"

const MAX_LINES = 50
const LINE_PREVIEW_CHARS = 60
const MAX_LINE_CHARS = 2_000

const ForgetParametersSchema = Schema.Struct({
  lines: Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(MAX_LINE_CHARS)))
    .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_LINES))
    .annotate({
      description: `Each whole line to forget, as a Memory page holds it, 1 to ${MAX_LINES}. Every copy on every page is removed.`
    })
    .pipe(Schema.optionalKey),
  claim: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CLAIM_CHARS))
    .pipe(Schema.annotateEncoded({ description: "What the user said is wrong, in one line." }))
    .pipe(Schema.optionalKey),
  undo: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
    .annotate({
      description:
        "Instead of lines and claim: the number of an entry this tool reported, to undo it."
    })
    .pipe(Schema.optionalKey)
}).check(
  Schema.makeFilter((input) =>
    (input.lines !== undefined && input.claim !== undefined) !== (input.undo !== undefined)
      ? undefined
      : "Provide lines and claim, or undo alone"
  )
)

const FORGET_REQUEST = { forget: "forget", undo: "undo" } as const

type ForgetRequest =
  | {
      readonly kind: typeof FORGET_REQUEST.forget
      readonly lines: ReadonlyArray<string>
      readonly claim: string
    }
  | { readonly kind: typeof FORGET_REQUEST.undo; readonly id: number }

const requestOf = (input: typeof ForgetParametersSchema.Type): ForgetRequest =>
  input.undo !== undefined
    ? { kind: "undo", id: input.undo }
    : { kind: "forget", lines: input.lines ?? [], claim: input.claim ?? "" }

const isForgetRefusal = (error: WikiError): boolean =>
  error.operation === WIKI_OPERATION.forget &&
  (error.reason === WIKI_ERROR_REASON.invalid || error.reason === WIKI_ERROR_REASON.not_found)

const forgetRefusal = (error: WikiError): ToolExecutionError =>
  new ToolExecutionError(error.message, { preview: "Nothing forgotten", retryable: false })

const forgetFailure = (error: WikiError): ToolExecutionError =>
  isForgetRefusal(error) ? forgetRefusal(error) : wikiFailure(error)

const changeDiff = (change: RetractionChange): string =>
  change.pages.map((page) => boundedDiff(page.path, page.before, page.after)).join("\n")

const removedPages = (change: RetractionChange): ReadonlyArray<string> => [
  ...new Set(change.entry.removed.map((removed) => removed.path))
]

const pagesPerLine = (lines: ReadonlyArray<string>, change: RetractionChange): string =>
  lines
    .map((line) => {
      const key = claimKey(line)
      const pages = new Set(
        change.entry.removed.flatMap((removed) =>
          claimKey(removed.line) === key ? [removed.path] : []
        )
      )
      return `${clipLine(line, LINE_PREVIEW_CHARS)}: ${countOf(pages.size, "page")}`
    })
    .join("\n")

const makeMemoryForgetTools = ({
  wiki,
  sessions
}: {
  readonly wiki: Wiki["Service"]
  readonly sessions: Pick<SessionQueries["Service"], "loadHistoryHeader">
}): ReadonlyArray<ServerTool> => {
  const ownerTurn = async (ctx: ToolContext<ServerRunContext>) => {
    await requireOwnerTurn(
      sessions,
      ctx.run,
      ctx.signal,
      { kind: "memory_forget" },
      {
        unverifiedBefore: "forgetting Memory",
        notOwnerTurn: "Memory is forgotten only in the user's own turn, after their approval"
      }
    )
    const chat = await chatLinkOf(sessions, ctx.run.sessionId, ctx.signal)
    if (chat === undefined)
      throw new ToolExecutionError("This chat no longer exists, so nothing was forgotten.", {
        preview: "Session unavailable",
        retryable: false
      })
    return {
      sessionId: ctx.run.sessionId,
      chat,
      authority: memoryLocation(ctx.run.authority.memory)
    }
  }

  const plan = async (request: ForgetRequest, ctx: ToolContext<ServerRunContext>) => {
    const turn = await ownerTurn(ctx)
    return Effect.runPromise(
      (request.kind === FORGET_REQUEST.forget
        ? wiki.planForget({ lines: request.lines, claim: request.claim, turn })
        : wiki.planUndoForget({ id: request.id, turn })
      ).pipe(Effect.mapError(forgetFailure)),
      { signal: ctx.signal }
    )
  }

  return [
    defineServerTool({
      name: "memory_forget",
      summary: "Forgets lines of your memory everywhere they appear, or undoes that.",
      discovery: { group: "wiki_admin" },
      description: [
        "Forget lines of Memory the user says are wrong: removes every copy of each line from every page in one change and opens a numbered entry,",
        "so no later write but the user's own can put those lines back. undo closes an entry.",
        "Works only during the user's own turn in a chat, and always asks the user first."
      ].join(" "),
      parameters: Schema.toStandardSchemaV1(ForgetParametersSchema),
      metadata: {
        effect: "arden_db",
        display_name: "Forget in Memory",
        kind: "tool",
        action: "write",
        default_approval: "ask",
        always_ask: true,
        approval_preview: "Forget lines of Memory everywhere they appear.",
        source: "_wiki",
        changes_state: true,
        concurrency_group: "wiki_write",
        destructive: true,
        target: "reported"
      },
      approvalPrompt: async (input, ctx) => {
        const request = requestOf(input)
        const change = await plan(request, ctx)
        return {
          preview:
            request.kind === FORGET_REQUEST.forget
              ? `Forget ${countOf(change.entry.removed.length, "line")} on ${countOf(removedPages(change).length, "page")}`
              : `Undo forgotten entry ${request.id}`,
          presentation: {
            title:
              request.kind === FORGET_REQUEST.forget
                ? "Forget this in Memory?"
                : "Let this back into Memory?",
            subject: change.entry.claim,
            fields:
              request.kind === FORGET_REQUEST.forget
                ? [{ label: "Pages per line", value: pagesPerLine(request.lines, change) }]
                : [],
            approve_label: request.kind === FORGET_REQUEST.forget ? "Forget" : "Undo",
            reject_label: "Keep as is"
          },
          diff: changeDiff(change)
        }
      },
      execute: async (input, ctx, effects) => {
        const request = requestOf(input)
        const turn = await ownerTurn(ctx)
        const change = await Effect.runPromise(
          (request.kind === FORGET_REQUEST.forget
            ? wiki.forget({ lines: request.lines, claim: request.claim, turn })
            : wiki.undoForget({ id: request.id, turn })
          ).pipe(Effect.mapError(forgetFailure)),
          { signal: ctx.signal }
        )
        effects.applied()
        const pages = removedPages(change)
        return request.kind === FORGET_REQUEST.forget
          ? {
              result: `Forgot entry ${change.entry.id}: removed ${countOf(change.entry.removed.length, "line")} from ${pages.join(", ")}. A later write that would put one back is refused unless the user makes it; undo ${change.entry.id} lifts the entry.`,
              preview: "Forgotten",
              data: { entry: change.entry.id, removed: change.entry.removed.length, pages }
            }
          : {
              result: `Undid entry ${change.entry.id}. Its ${countOf(change.entry.removed.length, "line")} may be written again; none was put back.`,
              preview: "Forgetting undone",
              data: { entry: change.entry.id, removed: change.entry.removed.length, pages }
            }
      }
    })
  ]
}

export const memoryForgetTools = Effect.gen(function* () {
  return makeMemoryForgetTools({ wiki: yield* Wiki, sessions: yield* SessionQueries })
})
