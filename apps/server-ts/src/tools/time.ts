import { machineTimeZone } from "@arden-hq/std/time"
import { Effect, Schema } from "effect"

import { defineServerTool, type ServerTool } from "./define.js"
import { currentMillis } from "../runtime/clock.js"

const EmptyParametersSchema = Schema.Record(Schema.String, Schema.Never)

const makeCurrentTimeTool = (): ServerTool =>
  defineServerTool({
    name: "current_time",
    description: "Get the current date and time in the user's local timezone.",
    parameters: Schema.toStandardSchemaV1(EmptyParametersSchema),
    metadata: {
      effect: "none",
      display_name: "Current Time",
      kind: "tool",
      action: "read",
      approval_preview: "Read the current local time.",
      source: "_system",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async () => {
      const timestamp = new Date(currentMillis())
      const timeZone = machineTimeZone()
      const local = new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone
      }).format(timestamp)
      return {
        result: `${local} (${timeZone})`,
        preview: local,
        data: {
          timestamp: local,
          timezone: timeZone,
          utc: timestamp.toISOString()
        }
      }
    }
  })

export const timeTools = Effect.sync(() => [makeCurrentTimeTool()])
