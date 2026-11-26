import { Schema } from "effect"
import { expect, it } from "vitest"

import {
  RunListQuerySchema,
  RunQuestionListQuerySchema,
  WorkerAttemptPageQuerySchema,
  runListOptions,
  runQuestionListOptions,
  workerAttemptPageOptions
} from "@arden-hq/protocol/effect/runs"
import {
  runRoutes,
  type RunListOptions,
  type RunQuestionListOptions,
  type WorkerAttemptPageOptions
} from "@arden-hq/protocol/runs"

const queryOf = (path: string): Record<string, string> =>
  Object.fromEntries(new URL(path, "http://local").searchParams)

it("reads back every question list option it writes", () => {
  const cases: ReadonlyArray<RunQuestionListOptions> = [
    { filter: { kind: "all" }, state: "actionable", page: { kind: "first" } },
    { filter: { kind: "space", space_id: "space-1" }, state: "all", page: { kind: "first" } },
    {
      filter: { kind: "session", session_id: "chat-1" },
      state: "actionable",
      page: { kind: "after", cursor: "c1" }
    },
    { filter: { kind: "task", item_id: "item-1" }, state: "all", page: { kind: "first" } }
  ]
  for (const options of cases) {
    const query = Schema.decodeUnknownSync(RunQuestionListQuerySchema)(
      queryOf(runRoutes.questions(options))
    )
    expect(runQuestionListOptions(query)).toEqual(options)
  }
})

it("reads back every Run list and attempt page option it writes", () => {
  const lists: ReadonlyArray<RunListOptions> = [
    { filter: { kind: "all" }, active: false, limit: 500, page: { kind: "first" } },
    {
      filter: { kind: "session", session_id: "chat-1" },
      active: true,
      limit: 20,
      page: { kind: "after", cursor: "2026-01-01T00:00:00Z|run-1" }
    }
  ]
  for (const options of lists) {
    const query = Schema.decodeUnknownSync(RunListQuerySchema)(queryOf(runRoutes.list(options)))
    expect(runListOptions(query)).toEqual(options)
  }
  const attempts: ReadonlyArray<WorkerAttemptPageOptions> = [
    { limit: 25, page: { kind: "first" } },
    { limit: 100, page: { kind: "after", cursor: 7 } }
  ]
  for (const options of attempts) {
    const query = Schema.decodeUnknownSync(WorkerAttemptPageQuerySchema)(
      queryOf(runRoutes.taskAttempts("item-1", options))
    )
    expect(workerAttemptPageOptions(query)).toEqual(options)
  }
})
