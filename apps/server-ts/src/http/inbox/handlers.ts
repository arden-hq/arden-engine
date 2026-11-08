import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InboxStore } from "../../persistence/inbox/store.js"
import { ArdenApi } from "../api.js"
import { failStore } from "../errors.js"
import { inboxToWire } from "../wire/inbox.js"

export const InboxHandlers = HttpApiBuilder.group(
  ArdenApi,
  "inbox",
  Effect.fn("InboxHandlers")(function* (handlers) {
    const store = yield* InboxStore

    return handlers
      .handle("view", () =>
        store.view().pipe(
          Effect.map(inboxToWire),
          Effect.mapError(() => new HttpApiError.InternalServerError({}))
        )
      )
      .handle("markRead", ({ payload }) =>
        store.markRead(payload).pipe(Effect.map(inboxToWire), Effect.catch(failStore))
      )
      .handle("dismiss", ({ payload }) =>
        store
          .dismiss(
            payload.scope === "group" ? { scope: "group", groupKey: payload.group_key } : payload
          )
          .pipe(Effect.map(inboxToWire), Effect.catch(failStore))
      )
  })
)
