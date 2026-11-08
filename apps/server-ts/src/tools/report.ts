import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { toolFailure } from "./tool-failure.js"
import { recordApplied } from "../execution/tool-effect.js"
import { WorkStore, type WorkStoreError } from "../persistence/work/store.js"
import { AUTOMATION_BLOCKED_KINDS, AutomationQueue } from "../persistence/automations/queue.js"
import type { AutomationStoreError } from "../persistence/automations/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { appliedReceipt, inChatTarget } from "./call-receipt.js"
import type { ServerRunContext } from "./run-context.js"
import { RUN_VERDICTS } from "../prompts/run-verdicts.js"

const ReportToolInputSchema = Schema.Union([
  Schema.Struct({
    event: Schema.Literal("blocked"),
    kind: Schema.Literals(AUTOMATION_BLOCKED_KINDS).annotate({
      description: [
        "transient: a temporary problem that a later attempt may clear.",
        "needs_input: the user must decide or supply something.",
        "capability: no available tool can do this.",
        "dependency: other work must finish first."
      ].join(" ")
    }),
    line: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(400)).pipe(
      Schema.annotateEncoded({
        description:
          "The user reads this. One or two plain sentences addressed to them: what is stuck and what they can do about it. Never name tools, IDs, rules or Arden's internal terms."
      })
    )
  }),
  Schema.Struct({
    event: Schema.Literal("news"),
    line: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(400)).pipe(
      Schema.annotateEncoded({
        description:
          "The finding in one plain sentence addressed to the user. Never name tools, IDs, rules or Arden's internal terms."
      })
    )
  }),
  Schema.Struct({
    event: Schema.Literal("no_change"),
    evidence: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)).pipe(
      Schema.annotateEncoded({
        description: "Evidence checked and why it adds no meaningful change."
      })
    )
  })
]).pipe(Schema.toTaggedUnion("event"))

const failure = (error: WorkStoreError | AutomationStoreError): ToolExecutionError =>
  toolFailure(error, "Report not recorded")

interface ReportToolServices {
  readonly work: WorkStore["Service"]
  readonly queue: AutomationQueue["Service"]
  readonly sessions: SessionQueries["Service"]
}

const makeReportTool = ({ work, queue, sessions }: ReportToolServices): ServerTool =>
  defineServerTool({
    name: "report",
    description: [
      "Record a verdict on this Run: news, no_change or blocked. Your final reply is how the user hears what this Run did; a question or approval waiting on the user is its own record and needs no report.",
      RUN_VERDICTS.news,
      RUN_VERDICTS.no_change,
      RUN_VERDICTS.blocked,
      "A report does not update a Task or settle a question."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(ReportToolInputSchema),
    metadata: {
      display: { row: "report" },
      effect: "run_record",
      outcome: true,
      display_name: "Report",
      kind: "tool",
      action: "write",
      source: "_runs",
      changes_state: true,
      target: "reported",
      concurrency_group: "communication",
      destructive: false,
      idempotent: true,
      ends_turn: { argument: "event", equals: "blocked" }
    },
    execute: async (input, ctx, effects) => {
      if (input.event === "blocked") {
        await recordApplied(
          effects,
          Effect.runPromise(
            queue
              .reportBlocked({
                sessionId: ctx.run.sessionId,
                chatRunId: ctx.run.runId,
                report: { kind: input.kind, reason: input.line }
              })
              .pipe(Effect.mapError(failure)),
            { signal: ctx.signal }
          )
        )
        return {
          result: `Blocked: ${input.line}`,
          preview: "Reported blocked",
          data: { status: "blocked", kind: input.kind, reason: input.line },
          host: await verdictReceipt(sessions, ctx, `Blocked: ${input.line}`)
        }
      }
      if (input.event === "news") {
        effects.applied()
        return {
          result: "News recorded. Say it in your final reply; the user sees this Run's line.",
          preview: "News recorded",
          host: await verdictReceipt(sessions, ctx, `News: ${input.line}`)
        }
      }
      const { quiet } = await recordApplied(
        effects,
        Effect.runPromise(
          work.reportNoChange(ctx.run.runId, input.evidence).pipe(Effect.mapError(failure)),
          { signal: ctx.signal }
        )
      )
      const host = await verdictReceipt(sessions, ctx, `No change: ${input.evidence}`)
      return quiet
        ? {
            host,
            result:
              "No-change outcome recorded. The Run remains inspectable; its routine completion will stay quiet if no actions or questions follow.",
            preview: "No change recorded"
          }
        : {
            host,
            result:
              "No-change reason recorded. This Run used a tool that may change state, so its result is delivered as usual instead of staying quiet.",
            preview: "Delivered as usual"
          }
    }
  })

const verdictReceipt = async (
  sessions: SessionQueries["Service"],
  ctx: ToolContext<ServerRunContext>,
  title: string
): Promise<Readonly<Record<string, unknown>>> => {
  const header = await Effect.runPromise(
    sessions.loadHistoryHeader(ctx.run.sessionId).pipe(Effect.orElseSucceed(() => null))
  )
  return appliedReceipt(
    ctx,
    inChatTarget({ resourceRef: `run:${ctx.run.runId}`, title, chat: header ?? undefined })
  )
}

export const reportTools = Effect.gen(function* () {
  return [
    makeReportTool({
      work: yield* WorkStore,
      queue: yield* AutomationQueue,
      sessions: yield* SessionQueries
    })
  ]
})
