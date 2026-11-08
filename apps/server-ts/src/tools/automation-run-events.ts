import { ToolExecutionError } from "@arden-hq/loop"
import { AUTOMATION_EVENT_TYPES } from "@arden-hq/protocol/automations"
import { Clock, Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { pageRunEvents } from "../persistence/automations/event-batch.js"
import { renderEventPage, SHOWN_EVENTS } from "../persistence/automations/event-text.js"
import { AutomationQueue } from "../persistence/automations/queue.js"

const MAX_EVENTS = 50

const RunEventsParametersSchema = Schema.Struct({
  offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))
    .annotate({ description: "Zero-based position in the newest-first list. Defaults to 0." })
    .pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_EVENTS }))
    .annotate({
      description: `Events per page, from 1 to ${MAX_EVENTS}. Defaults to ${SHOWN_EVENTS}.`
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed(SHOWN_EVENTS))),
  event_type: Schema.optionalKey(
    Schema.Literals(AUTOMATION_EVENT_TYPES).annotate({
      description: "List only events of this type. Omit to list every type."
    })
  )
})

const makeAutomationRunEventsTools = ({
  queue
}: {
  readonly queue: AutomationQueue["Service"]
}): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "automation_run_events",
    description:
      "List every event this Automation run woke for, newest first and paged, optionally of one type, each with the call that opens it. Use it when the run's event list says more events are not shown; in an Automation's chat after its run, it lists that chat's latest run.",
    parameters: Schema.toStandardSchemaV1(RunEventsParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      display_name: "List Run Events",
      kind: "tool",
      action: "read",
      approval_preview: "List the events this Automation run woke for.",
      source: "_automations",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (input, ctx) => {
      const [carried, now] = await Effect.runPromise(
        Effect.all([
          queue.runEvents({ sessionId: ctx.run.sessionId, chatRunId: ctx.run.runId }).pipe(
            Effect.mapError(
              (error) =>
                new ToolExecutionError(`${error.message}. Retry once; it reads saved records.`, {
                  preview: "Run events not read",
                  retryable: true
                })
            )
          ),
          Clock.currentTimeMillis
        ]),
        { signal: ctx.signal }
      )
      if (carried === undefined)
        throw new ToolExecutionError(
          "This chat has no Automation run, so no events woke it. To see an Automation's past runs, use automation_list_runs.",
          { preview: "Not an Automation chat", retryable: false }
        )
      const page = pageRunEvents(carried.events, {
        offset: input.offset,
        limit: input.limit,
        eventType: input.event_type
      })
      const pageText = renderEventPage(page, { now, eventType: input.event_type })
      return {
        result:
          carried.run === "this_run"
            ? pageText
            : `This turn is not an Automation run. These are the events of this chat's latest Automation run, started ${carried.startedAt}.\n\n${pageText}`,
        preview: `${page.events.length} of ${page.total} events`,
        data: { total: page.total, offset: page.offset, next_offset: page.nextOffset ?? null }
      }
    }
  })
]

export const automationRunEventsTools = Effect.gen(function* () {
  return makeAutomationRunEventsTools({ queue: yield* AutomationQueue })
})
