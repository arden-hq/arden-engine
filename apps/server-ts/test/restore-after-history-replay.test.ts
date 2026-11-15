import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"

import { makeObservationRegistry, type ObservationRegistry } from "../src/tools/run-context.js"
import { namedTool, wikiToolsOver } from "./fixtures/wiki-repository.js"
import { partialService } from "./kit.js"
import { locateReplayCopy, runOnReplayCopy } from "./fixtures/replay-copy.js"
import type { Wiki } from "../src/wiki/service.js"

// Every wiki_restore_page call on the copy, replayed against today's restore gates with no
// model and no Memory write: today's parameters, and whether the run had seen the page by then,
// once under the old rule (a read or a write) and once with a history listing counting too.
// Pages are keyed by the path each call named. Only counts leave this file.

const located = locateReplayCopy()

/** Calls that, once finished without error, leave the run having seen the page at `path`. */
const SEES_PAGE = new Set([
  "wiki_read_page",
  "wiki_edit_page",
  "wiki_patch_page",
  "wiki_create_page",
  "wiki_restore_page"
])

interface CallRow {
  readonly run_id: string
  readonly tool_name: string
  readonly arguments_json: string
  readonly is_error: number | null
  readonly preview: string | null
}

const pathOf = (row: CallRow): string | undefined => {
  const parsed: unknown = JSON.parse(row.arguments_json)
  if (typeof parsed !== "object" || parsed === null || !("path" in parsed)) return undefined
  return typeof parsed.path === "string" ? parsed.path : undefined
}

it("replays every page restore on the copy against today's gates", async (context) => {
  if (located.kind === "absent") return context.skip(located.reason)
  const rows = await runOnReplayCopy(
    located.copy,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* sql<CallRow>`SELECT run_id, tool_name, arguments_json,
          json_extract(result_json, '$.is_error') AS is_error,
          json_extract(result_json, '$.preview') AS preview
        FROM tool_calls
        WHERE run_id IN (SELECT run_id FROM tool_calls WHERE tool_name = 'wiki_restore_page')
        ORDER BY run_id, started_at, tool_call_id`
    })
  )
  const restore = namedTool(
    wikiToolsOver(partialService<Wiki["Service"]>("Wiki", {})),
    "wiki_restore_page"
  )
  const decodes = async (row: CallRow): Promise<boolean> => {
    const validated = await restore.definition.parameters["~standard"].validate(
      JSON.parse(row.arguments_json)
    )
    return validated.issues === undefined
  }
  const before = new Map<string, ObservationRegistry>()
  const after = new Map<string, ObservationRegistry>()
  const registry = (runs: Map<string, ObservationRegistry>, runId: string) => {
    const existing = runs.get(runId)
    if (existing !== undefined) return existing
    const made = makeObservationRegistry()
    runs.set(runId, made)
    return made
  }
  const counts = {
    restores: 0,
    awaitedApproval: 0,
    readFirst: 0,
    restored: 0,
    acceptedByTodaysParameters: 0,
    readFirstSeenByReadOrWrite: 0,
    readFirstSeenOnceHistoryCounts: 0
  }
  for (const row of rows) {
    const path = pathOf(row)
    if (row.tool_name === "wiki_restore_page") {
      counts.restores += 1
      if (await decodes(row)) counts.acceptedByTodaysParameters += 1
      if (row.preview === "Waits on the user's approval") counts.awaitedApproval += 1
      if (row.preview === "Wiki page restored") counts.restored += 1
      if (row.preview === "Read required") {
        counts.readFirst += 1
        if (path !== undefined && registry(before, row.run_id).observed(path) !== undefined)
          counts.readFirstSeenByReadOrWrite += 1
        if (path !== undefined && registry(after, row.run_id).observed(path) !== undefined)
          counts.readFirstSeenOnceHistoryCounts += 1
      }
    }
    if (path === undefined || row.is_error === 1) continue
    if (SEES_PAGE.has(row.tool_name)) {
      registry(before, row.run_id).observe(path, "seen")
      registry(after, row.run_id).observe(path, "seen")
    }
    if (row.tool_name === "wiki_page_history") registry(after, row.run_id).observe(path, "seen")
  }
  // Vitest swallows console output; a direct write reaches the terminal.
  process.stdout.write(`Restore replay: ${JSON.stringify(counts)}\n`)
  expect(counts.readFirstSeenOnceHistoryCounts).toBeGreaterThanOrEqual(
    counts.readFirstSeenByReadOrWrite
  )
})
