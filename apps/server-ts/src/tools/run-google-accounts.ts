import type { GoogleAccountGrant } from "@arden-hq/protocol/google"
import { Effect } from "effect"
import { GoogleConnectionError } from "../google/errors.js"
import type { GoogleConnections } from "../google/service.js"
import type { RunQueries } from "../persistence/runs/queries.js"
import type { GoogleToolConnections } from "./google-accounts.js"

export const bindRunGoogleAccounts = (options: {
  readonly google: GoogleConnections["Service"]
  readonly runs: RunQueries["Service"]
  readonly runId: string
  readonly grants: ReadonlyArray<GoogleAccountGrant> | null
}): GoogleToolConnections => ({
  accounts: () =>
    options.google.accounts().flatMap((account) => {
      if (options.grants === null) return [account]
      const authorizations = account.authorizations.filter((authorization) =>
        options.grants?.some(
          (grant) => grant.account_id === account.id && grant.service === authorization.service
        )
      )
      return authorizations.length === 0 ? [] : [{ ...account, authorizations }]
    }),
  request: (request) =>
    options.google.request({
      ...request,
      access: {
        allowedAccountIds: () =>
          Effect.runPromise(
            options.runs.googleAccounts(options.runId, request.service).pipe(
              Effect.mapError(
                (cause) =>
                  new GoogleConnectionError({
                    reason: "storage",
                    message: "Run account access is unavailable",
                    cause
                  })
              )
            )
          )
      }
    })
})
