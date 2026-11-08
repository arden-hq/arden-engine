import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"
import { BrowserProcedures } from "../browser/procedures/service.js"
import { BrowserProcedureStore } from "../persistence/browser-procedures/store.js"
import { BrowserClient } from "../browser/service.js"
import { defineServerTool } from "./define.js"
import { runBrowserForRun, webUrl } from "./browser-support.js"

export const browserProcedureTools = Effect.gen(function* () {
  const procedures = yield* BrowserProcedures
  const store = yield* BrowserProcedureStore
  const browser = yield* BrowserClient
  return [
    defineServerTool({
      name: "browser_procedure",
      description:
        "Run saved browser steps discovered by browser_snapshot. Supply this task's input values, never copied example values. It uses the same browser tools, approvals and current page; its independent read-back must confirm the result. If no saved procedure fits, use browser_task or ordinary browser tools.",
      parameters: Schema.toStandardSchemaV1(
        Schema.Struct({
          tab_ref: Schema.String,
          procedure_id: Schema.String,
          input: Schema.Record(Schema.String, Schema.Json)
        })
      ),
      metadata: {
        display_name: "Run saved browser steps",
        kind: "browser",
        action: "read",
        source: "_browser",
        changes_state: false,
        concurrency_group: "browser",
        destructive: false,
        effect: "none",
        code_mode: false,
        detached: true
      },
      execute: async (input, ctx) => {
        const tabs = await runBrowserForRun(browser, ctx, { type: "tabs" }, ctx.signal)
        const listed = Schema.decodeUnknownOption(
          Schema.Struct({
            tabs: Schema.Array(
              Schema.Struct({
                tab_ref: Schema.String,
                profile_ref: Schema.String,
                url: Schema.String
              })
            )
          })
        )(tabs.data)
        const tab =
          listed._tag === "Some"
            ? listed.value.tabs.find((t) => t.tab_ref === input.tab_ref)
            : undefined
        const origin = tab === undefined ? undefined : webUrl(tab.url)?.origin
        if (tab === undefined || origin === undefined)
          throw new ToolExecutionError("The procedure's browser tab is unavailable.", {
            preview: "Browser tab unavailable",
            retryable: false
          })
        const release = ctx.run.browserObservations.lease(input.tab_ref, ctx.toolCallId)
        if (release === undefined)
          throw new ToolExecutionError("This tab is already being used.", {
            preview: "Tab in use",
            retryable: true
          })
        try {
          const result = await procedures.tryRun(
            {
              tab: input.tab_ref,
              url: tab.url,
              origin,
              profile: tab.profile_ref,
              goal: "",
              values: "",
              procedureId: input.procedure_id,
              input: input.input
            },
            ctx
          )
          if (result === undefined)
            return {
              result:
                "Saved steps did not fit or stopped. Read the current page and continue with ordinary browser tools; do not repeat a possible write without read-back.",
              preview: "Continue from the current page"
            }
          return result
        } finally {
          release()
        }
      }
    }),
    defineServerTool({
      name: "browser_procedure_verify",
      description:
        "Internal saved-procedure checkpoint. Switch this invocation permanently to read-only verification. Only callable from a recorded browser procedure.",
      parameters: Schema.toStandardSchemaV1(Schema.Struct({})),
      metadata: {
        display_name: "Verify browser result",
        kind: "browser",
        action: "read",
        source: "_browser",
        changes_state: false,
        concurrency_group: null,
        destructive: false,
        effect: "none",
        internal_catalog: true,
        invocation_only: true
      },
      execute: async (_input, ctx) => {
        if ((await Effect.runPromise(store.scope(ctx.run.runId, ctx.toolCallId))) === undefined)
          throw new ToolExecutionError("This checkpoint belongs to a saved browser procedure.", {
            preview: "Procedure required",
            retryable: false
          })
        await Effect.runPromise(store.readOnly(ctx.run.runId, ctx.toolCallId))
        return { result: "Read-only verification started.", preview: "Verify the result" }
      }
    })
  ]
})
