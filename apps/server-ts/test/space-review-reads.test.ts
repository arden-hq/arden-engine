import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"

import { SpaceReviewStore } from "../src/persistence/automations/space-review-store.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

const page = { pageId: "p1", path: "p1.md", version: "v1", basis: "resident" }
const retiredInput = {
  admission: "changed",
  spaceId: "space-1",
  repositoryHead: null,
  pages: [{ ...page, rootPageId: "p1" }],
  chats: [],
  semantic: "{}",
  unresolved: [],
  reads: {
    space: { name: "Made up", instructions: null },
    openTasks: [],
    proposals: [],
    memory: { base: null, head: null },
    pages: [{ ...page, previousVersion: null }],
    chats: [],
    removed: [],
    items: []
  },
  prompt: "Made-up prompt"
}

it("reads only a running review's input, so a finished one is an archive no schema reads", async () => {
  const outcome = await withTempDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const reviews = yield* SpaceReviewStore
      const at = "2026-11-01T00:00:00.000Z"
      yield* sql`INSERT INTO automation_runs
        (task_id, purpose, started_at, ended_at, status, chat_run_id, input_json)
        VALUES ('job', 'space_review', ${at}, ${at}, 'completed', 'run-finished',
          ${JSON.stringify(retiredInput)})`
      return yield* reviews.reviewReads("run-finished").pipe(
        Effect.match({
          onFailure: (error) => error.message,
          onSuccess: (reads) => reads ?? "none"
        })
      )
    })
  )
  expect(outcome).toBe("none")
})

it("no server statement reads a finished run's stored input", () => {
  const root = join(import.meta.dirname, "../src")
  const sources = (directory: string): ReadonlyArray<string> =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return entry.name === "migrations" ? [] : sources(path)
      return entry.name.endsWith(".ts") ? [path] : []
    })
  const readers = sources(root).flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(/`[^`]*`/gu)]
      .map((statement) => statement[0])
      .filter((statement) =>
        /\bSELECT\b[\s\S]*\binput_json\b[\s\S]*\bFROM automation_runs\b/u.test(statement)
      )
      .map((statement) => ({
        file: relative(root, path),
        runningOnly: /\bstatus = 'running'/u.test(statement)
      }))
  )
  expect(readers).toEqual([{ file: "persistence/sqlite/space-review.ts", runningOnly: true }])
})
