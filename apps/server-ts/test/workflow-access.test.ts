import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { ScriptRecord, ScriptStore } from "../src/persistence/scripts/store.js"
import type { SessionQueries } from "../src/persistence/sessions/queries.js"
import { readOwnedScript } from "../src/workflows/access.js"

const record = {
  ref: "wf-1",
  originSessionRef: "parent-ref",
  originSessionId: "parent-session",
  originRunId: "run-1",
  originToolCallId: "call-1",
  profileHash: "profile",
  status: "succeeded",
  version: 1,
  attempt: 1,
  autoRetries: 0,
  error: null,
  createdAt: "2026-10-14T00:00:00.000Z",
  updatedAt: "2026-10-14T00:00:00.000Z",
  endedAt: "2026-10-14T00:00:00.000Z"
} satisfies ScriptRecord

const access = (allowedSessionRefs?: ReadonlyArray<string>) =>
  readOwnedScript({
    store: {
      get: () => Effect.succeed(record)
    } as unknown as ScriptStore["Service"],
    sessions: {
      loadHistoryHeader: () => Effect.succeed({ publicRef: "child-ref" })
    } as unknown as SessionQueries["Service"],
    ref: record.ref,
    sessionId: "child-session",
    ...(allowedSessionRefs === undefined ? {} : { allowedSessionRefs })
  })

describe("workflow shared resource access", () => {
  it("reads a workflow only when its origin session is explicitly shared", async () => {
    await expect(Effect.runPromise(access())).rejects.toMatchObject({ reason: "wrong_session" })
    await expect(Effect.runPromise(access(["other-ref"]))).rejects.toMatchObject({
      reason: "wrong_session"
    })
    await expect(Effect.runPromise(access(["parent-ref"]))).resolves.toBe(record)
  })
})
