import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { JOB_PURPOSE } from "../job-classification.js"
import { JOB_SUBJECT_KIND } from "../space-job-id.js"
import { spaceChoices } from "../spaces/store.js"
import { type TaskAddress, type WorkStoreError } from "../work/store.js"
import { readWorkOwner } from "./automation-rows.js"
import { workError } from "./work-records.js"

export type JobTarget = (
  originAutomationId: string,
  key: string,
  requestedSpaceId: string | undefined
) => Effect.Effect<TaskAddress, WorkStoreError>

export const makeWorkJobTarget = (sql: SqlClient.SqlClient): JobTarget => {
  const jobOrigin = Effect.fn("SqliteWorkStore.jobOrigin")(function* (
    originAutomationId: string
  ): Effect.fn.Return<
    {
      readonly spaceId: string | undefined
      readonly stableKey: string | null
      readonly itemId: string | null
    },
    WorkStoreError
  > {
    const storage = (cause: unknown) =>
      workError("storage", "Could not resolve job ownership", cause)
    const owner = yield* readWorkOwner(sql, originAutomationId).pipe(Effect.mapError(storage))
    if (owner === undefined) return yield* workError("invalid", "This job cannot change Tasks")
    switch (owner.kind) {
      case JOB_SUBJECT_KIND.task: {
        const items = yield* sql<{ readonly stable_key: string | null }>`
          SELECT stable_key FROM space_tasks WHERE item_id = ${owner.itemId}
        `.pipe(Effect.mapError(storage))
        return {
          spaceId: owner.spaceId ?? undefined,
          stableKey: items[0]?.stable_key ?? null,
          itemId: owner.itemId
        }
      }
      case JOB_SUBJECT_KIND.spaceReview:
        return { spaceId: owner.spaceId, stableKey: null, itemId: null }
      case JOB_SUBJECT_KIND.automation: {
        if (owner.purpose === JOB_PURPOSE.system)
          return yield* workError("invalid", "This job cannot change Tasks")
        const chats = yield* sql<{ readonly space_id: string | null }>`
          SELECT space_id FROM sessions
          WHERE session_id = ${owner.authored.chatId} AND archived_at IS NULL
        `.pipe(Effect.mapError(storage))
        return { spaceId: chats[0]?.space_id ?? undefined, stableKey: null, itemId: null }
      }
    }
  })

  const spaceChoiceWords = sql<{ readonly space_id: string; readonly name: string }>`
    SELECT space_id, name FROM spaces WHERE archived_at IS NULL ORDER BY name, space_id
  `.pipe(
    Effect.map(spaceChoices),
    Effect.mapError((cause) => workError("storage", "Could not list the Spaces", cause))
  )

  const jobSpace = Effect.fn("SqliteWorkStore.jobSpace")(function* (
    origin: { readonly spaceId: string | undefined },
    requestedSpaceId: string | undefined
  ): Effect.fn.Return<string, WorkStoreError> {
    const spaceId = requestedSpaceId ?? origin.spaceId
    if (spaceId === undefined)
      return yield* workError(
        "invalid",
        `This run's chat is in no Space, so name the Space for the Task. ${yield* spaceChoiceWords}`
      )
    if (requestedSpaceId === undefined) return spaceId
    const active = yield* sql`
      SELECT 1 FROM spaces WHERE space_id = ${requestedSpaceId} AND archived_at IS NULL
    `.pipe(Effect.mapError((cause) => workError("storage", "Could not validate the Space", cause)))
    if (active.length === 0)
      return yield* workError(
        "not_found",
        `No active Space has id '${requestedSpaceId}'. ${yield* spaceChoiceWords}`
      )
    return spaceId
  })

  return Effect.fn("SqliteWorkStore.jobTarget")(function* (
    originAutomationId: string,
    key: string,
    requestedSpaceId: string | undefined
  ): Effect.fn.Return<TaskAddress, WorkStoreError> {
    const origin = yield* jobOrigin(originAutomationId)
    if (origin.stableKey !== null && origin.stableKey !== key) {
      return yield* workError("invalid", "This job cannot mutate that Space task")
    }
    if (
      origin.spaceId !== undefined &&
      requestedSpaceId !== undefined &&
      requestedSpaceId !== origin.spaceId
    )
      return yield* workError("invalid", "This job can change only Tasks on its own Space")
    if (origin.itemId !== null) return { kind: "item", itemId: origin.itemId }
    return {
      kind: "key",
      scope: { kind: "space", spaceId: yield* jobSpace(origin, requestedSpaceId) },
      key
    }
  })
}
