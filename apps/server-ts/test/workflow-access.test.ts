import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { Actor } from "../src/execution/authority.js"
import { ScriptJournal } from "../src/persistence/scripts/journal.js"
import { ScriptResults } from "../src/persistence/scripts/results.js"
import { ScriptStore, type ScriptRecord } from "../src/persistence/scripts/store.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { WORKFLOW_CANCEL_TOOL } from "../src/persistence/tools/tool-roles.js"
import { workflowTools } from "../src/tools/workflows.js"
import { readOwnedScript } from "../src/workflows/access.js"
import { ScriptRunner } from "../src/workflows/script-runner.js"
import { partialService, present, runAuthority, serverRunContext, sessionHeader } from "./kit.js"

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

const runningRecord = { ...record, status: "running", endedAt: null } satisfies ScriptRecord

const cancelTool = (cancelled: Array<string>) => {
  const tools = Effect.runSync(
    workflowTools.pipe(
      Effect.provideService(
        ScriptStore,
        partialService<ScriptStore["Service"]>("ScriptStore", {
          get: () => Effect.succeed(runningRecord)
        })
      ),
      Effect.provideService(
        SessionQueries,
        partialService<SessionQueries["Service"]>("SessionQueries", {
          loadHistoryHeader: () => Effect.succeed(sessionHeader({ publicRef: "parent-ref" }))
        })
      ),
      Effect.provideService(ScriptJournal, partialService("ScriptJournal", {})),
      Effect.provideService(ScriptResults, partialService("ScriptResults", {})),
      Effect.provideService(
        ScriptRunner,
        partialService<ScriptRunner["Service"]>("ScriptRunner", {
          cancel: (input) => {
            cancelled.push(input.ref)
            return Effect.succeed({ ...runningRecord, status: "cancelled" })
          }
        })
      )
    )
  )
  return present(
    tools.find((tool) => tool.definition.name === WORKFLOW_CANCEL_TOOL),
    WORKFLOW_CANCEL_TOOL
  )
}

const cancelAs = (runId: string, actor: Actor) => {
  const cancelled: Array<string> = []
  const outcome = cancelTool(cancelled).execute(
    { workflow_ref: record.ref },
    {
      toolCallId: "call-cancel",
      signal: new AbortController().signal,
      run: serverRunContext({
        sessionId: "parent-session",
        runId,
        authority: runAuthority({ actor })
      }),
      messages: []
    }
  )
  return { outcome, cancelled }
}

const agent: Actor = { kind: "agent", mode: "code", parent_run_id: "run-2", root: "person" }

describe("workflow_cancel caller", () => {
  it("refuses a run that did not start the script and does not act as the person", async () => {
    const { outcome, cancelled } = cancelAs("run-2", agent)
    await expect(outcome).rejects.toBeInstanceOf(Error)
    expect(cancelled).toEqual([])
  })

  it("lets the run that started the script, or the person, stop it", async () => {
    const origin = cancelAs(record.originRunId, agent)
    await expect(origin.outcome).resolves.toMatchObject({ is_error: false })
    expect(origin.cancelled).toEqual([record.ref])

    const person = cancelAs("run-2", runAuthority().actor)
    await expect(person.outcome).resolves.toMatchObject({ is_error: false })
    expect(person.cancelled).toEqual([record.ref])
  })
})
