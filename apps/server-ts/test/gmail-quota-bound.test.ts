import type { GoogleAccount } from "@arden-hq/protocol/google"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { fetchGmail } from "../src/connections/items/gmail.js"

const PER_USER_UNITS_PER_MINUTE = 6000
const PROFILE_UNITS = 1
const LIST_UNITS = 5
const METADATA_GET_UNITS = 20
const RESULTS_PER_LIST = 200

const account: GoogleAccount = {
  id: "acct-1",
  email: "me@example.com",
  authorizations: [{ service: "gmail", scopes: [], status: "ready" }]
}

describe("a Gmail fetch against the per-user quota", () => {
  it("stays under the per-minute units with a full first list read at once", async () => {
    let units = 0
    let inFlight = 0
    let mostInFlight = 0
    const google = {
      request: (input: { readonly url: string }) =>
        Effect.gen(function* () {
          inFlight += 1
          mostInFlight = Math.max(mostInFlight, inFlight)
          yield* Effect.sleep("1 millis")
          inFlight -= 1
          if (input.url.endsWith("/profile")) {
            units += PROFILE_UNITS
            return { account, value: { historyId: "10" } }
          }
          if (input.url.includes("/messages?")) {
            units += LIST_UNITS
            const messages = Array.from({ length: RESULTS_PER_LIST }, (_, index) => ({
              id: `m${index}`
            }))
            return { account, value: { messages } }
          }
          units += METADATA_GET_UNITS
          const id = input.url.split("/messages/")[1]?.split("?")[0] ?? ""
          return { account, value: { id, threadId: `t-${id}`, internalDate: "1700000000000" } }
        })
    }
    const store = { threadOwned: () => Effect.succeed(false) }
    await Effect.runPromise(fetchGmail({ google, store, account, cursor: undefined }))
    expect(units).toBe(PROFILE_UNITS + LIST_UNITS + RESULTS_PER_LIST * METADATA_GET_UNITS)
    expect(units).toBeLessThan(PER_USER_UNITS_PER_MINUTE)
    expect(mostInFlight).toBeLessThanOrEqual(5)
  })
})
