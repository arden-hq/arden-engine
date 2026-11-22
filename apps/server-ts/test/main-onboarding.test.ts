import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { onboardingClientId, SessionStore } from "../src/persistence/sessions/store.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const AT = "2026-11-22T00:00:00.000Z"

const markOf = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly mark: string | null }>`
      SELECT json_type(metadata, '$.onboarding.at') AS mark FROM sessions
      WHERE session_id = ${sessionId}`
    return rows[0]?.mark ?? undefined
  })

it("Getting started starts once on a Main chat, never again after it ran, and never outside Main", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sessions = yield* SessionStore
      const spaces = yield* SpaceStore
      const sql = yield* SqlClient.SqlClient
      const main = (yield* spaces.list()).find((space) => space.kind === "main")
      if (main === undefined) return yield* Effect.die("no Main Space")
      const work = yield* spaces.create({ name: "Work" })
      const mainChat = yield* sessions.ensureSpaceConversation(main.space_id)
      const workChat = yield* sessions.create({ name: "Elsewhere", spaceId: work.space_id })

      const first = yield* sessions.startOnboarding(mainChat)
      const marked = yield* markOf(mainChat)
      const second = yield* sessions.startOnboarding(mainChat)
      yield* sql`INSERT INTO chat_idempotency_keys (session_id, client_id, request_hash, status,
          created_at, updated_at)
        VALUES (${mainChat}, ${onboardingClientId(mainChat)}, 'hash', 'accepted', ${AT}, ${AT})`
      yield* sessions.finishOnboarding(mainChat)
      const afterFinish = yield* sessions.startOnboarding(mainChat)
      const endedMark = yield* markOf(mainChat)
      const outside = yield* sessions.startOnboarding(workChat.sessionId).pipe(Effect.flip)
      const missing = yield* sessions.startOnboarding("no-such-chat").pipe(Effect.flip)
      return {
        first,
        marked,
        second,
        afterFinish,
        endedMark,
        outside: [outside.reason, outside.message],
        missing: missing.reason
      }
    })
  )
  expect(outcome).toEqual({
    first: true,
    marked: "text",
    second: false,
    afterFinish: false,
    endedMark: undefined,
    outside: ["conflict", "Getting started runs only in a chat in the Main Space"],
    missing: "not_found"
  })
})
