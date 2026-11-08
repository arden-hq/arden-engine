import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import type { GoogleServiceId } from "@arden-hq/protocol/google"
import { GoogleServiceIdSchema } from "@arden-hq/protocol/effect/google"
import { Effect, Schema } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import type { GoogleConnections } from "../google/service.js"
import type { RunQueries } from "../persistence/runs/queries.js"

export const makeGoogleAccountListTool = (services: {
  readonly google: Pick<GoogleConnections["Service"], "accounts">
  readonly runs: RunQueries["Service"]
}): ServerTool =>
  defineServerTool({
    name: "google_accounts_list",
    description:
      "List connected Google account IDs, emails and service authentication status. Workers see only their permitted services. Listing does not grant access or contact Google. needs_auth means reconnect in Settings before using that service.",
    parameters: Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Never)),
    metadata: {
      effect: "none",
      display_name: "List Google accounts",
      kind: "tool",
      action: "read",
      source: "_app",
      changes_state: false,
      destructive: false,
      concurrency_group: null,
      approval_preview: "Check which Google accounts are connected."
    },
    execute: async (_input, ctx) => {
      const run = await Effect.runPromise(services.runs.get(ctx.run.runId), { signal: ctx.signal })
      if (!run || run.sessionId !== ctx.run.sessionId) {
        throw new ToolExecutionError("This Run is required to list Google accounts", {
          preview: "Account discovery unavailable",
          retryable: false
        })
      }
      const grants = new Map<GoogleServiceId, ReadonlyArray<string> | null>()
      for (const service of GoogleServiceIdSchema.literals) {
        grants.set(
          service,
          await Effect.runPromise(services.runs.googleAccounts(run.runId, service), {
            signal: ctx.signal
          })
        )
      }
      const accounts = services.google.accounts().flatMap((account) => {
        const authorizations = account.authorizations.filter((authorization) => {
          const allowed = grants.get(authorization.service)
          return allowed === null || allowed?.includes(account.id) === true
        })
        if (authorizations.length === 0) return []
        return [
          {
            account_id: account.id,
            email: account.email,
            services: authorizations.map(({ service, status }) => ({ service, status }))
          }
        ]
      })
      return {
        result: JSON.stringify({ accounts }),
        preview: `${countOf(accounts.length, "Google account")}`,
        data: { accounts }
      }
    }
  })
