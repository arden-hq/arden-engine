import { ToolExecutionError } from "@arden-hq/loop"
import { DateTime, Effect, Schema } from "effect"
import { sessionForkOriginFromMetadata } from "../persistence/sessions/fork-origin.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { SummaryStore, type ChatSummary } from "../persistence/summaries/store.js"
import { defineServerTool, type ServerTool } from "./define.js"
import { recordApplied } from "../execution/tool-effect.js"
import { appliedReceipt, chatTarget } from "./call-receipt.js"

export const chatSummaryText = (summary: ChatSummary): string =>
  `Summary (through message ${summary.throughSequence}): ${summary.summary}${
    summary.topics.length === 0 ? "" : ` Topics: ${summary.topics.join("; ")}.`
  }`

const MAX_SUMMARY_CHARS = 280

const words = (text: string) => text.trim().split(/\s+/u).filter(Boolean).length

const ParametersSchema = Schema.Struct({
  outcome: Schema.Literals(["summary", "nothing_to_recall"]).annotate({
    description:
      '"summary" saves the fields below. "nothing_to_recall" means the chat holds nothing worth coming back to (a quick one-off question, a greeting, a test); nothing is saved and any earlier summary stays.'
  }),
  // Each description sits on the string, not on a custom filter: the JSON
  // Schema a model sees drops a filter together with its annotations.
  title: Schema.optionalKey(
    Schema.String.annotate({
      description: "At most 7 words naming what this chat is about: concrete nouns."
    }).check(
      Schema.makeFilter((title) =>
        title.trim().length > 0 && words(title) <= 7 ? undefined : "a title of 1 to 7 words"
      )
    )
  ),
  summary: Schema.optionalKey(
    Schema.String.annotate({
      description: `One or two sentences, at most ${MAX_SUMMARY_CHARS} characters (about 45 words): what the chat covered, what was decided or produced, what is still open.`
    }).check(
      Schema.isMaxLength(MAX_SUMMARY_CHARS),
      Schema.makeFilter((summary) =>
        summary.trim().length > 0 ? undefined : "a summary that is not blank"
      )
    )
  ),
  topics: Schema.optionalKey(
    Schema.Array(Schema.String).check(Schema.isMaxLength(5)).annotate({
      description:
        "Up to 5 short phrases (6 words or fewer) for the distinct subjects over the chat's whole life, most recent first."
    })
  )
})

const makeSetChatSummaryTool = (services: {
  readonly sessions: SessionQueries["Service"]
  readonly summaries: SummaryStore["Service"]
}): ServerTool =>
  defineServerTool({
    name: "set_chat_summary",
    description:
      "Save the summary of the chat this run was forked from: a short title, one or two sentences, and its topics, or say it holds nothing worth recalling. Used only by the Chat summaries Automation.",
    parameters: Schema.toStandardSchemaV1(ParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Save Chat Summary",
      kind: "tool",
      action: "write",
      approval_preview: "Save this chat's summary.",
      source: "_summaries",
      changes_state: true,
      target: "reported",
      concurrency_group: null,
      destructive: false,
      ends_turn: true,
      internal_catalog: true,
      private_scope: "chat_summary"
    },
    execute: async (input, ctx, effects) => {
      const snapshot = await Effect.runPromise(
        services.sessions.loadHeaderSnapshot(ctx.run.sessionId),
        {
          signal: ctx.signal
        }
      )
      const fork =
        snapshot === null
          ? undefined
          : sessionForkOriginFromMetadata(
              snapshot.metadata,
              DateTime.formatIso(snapshot.header.startedAt)
            )
      if (fork === undefined) {
        throw new ToolExecutionError(
          "This run is not a fork of a chat, so there is no chat to summarize.",
          {
            preview: "Not a chat fork",
            retryable: false
          }
        )
      }
      if (input.outcome === "nothing_to_recall") {
        return { result: "Nothing saved.", preview: "Nothing to recall" }
      }
      if (input.title === undefined || input.summary === undefined) {
        throw new ToolExecutionError('A "summary" outcome needs a title and a summary.', {
          preview: "Missing summary",
          retryable: true
        })
      }
      await recordApplied(
        effects,
        Effect.runPromise(
          services.summaries.setChat({
            sessionId: fork.sourceSessionId,
            title: input.title.trim(),
            summary: input.summary.trim(),
            topics: (input.topics ?? []).map((topic) => topic.trim()).filter(Boolean),
            throughSequence: fork.throughSequence,
            runId: ctx.run.runId
          }),
          { signal: ctx.signal }
        )
      )
      const source = await Effect.runPromise(
        services.sessions
          .loadHistoryHeader(fork.sourceSessionId)
          .pipe(Effect.orElseSucceed(() => null)),
        { signal: ctx.signal }
      )
      return {
        result: "Summary saved.",
        preview: input.title.trim(),
        ...(source === null
          ? {}
          : {
              host: appliedReceipt(
                ctx,
                chatTarget(source, source.name?.trim() || input.title.trim())
              )
            })
      }
    }
  })

export const chatSummaryTools = Effect.gen(function* () {
  return [
    makeSetChatSummaryTool({ sessions: yield* SessionQueries, summaries: yield* SummaryStore })
  ]
})
