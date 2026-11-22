import { type ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"

import { systemHandlerForAutomation } from "../src/automations/system.js"
import { AutomationId } from "../src/persistence/automations/model.js"
import { markedProducer, pageKind, recordFolders } from "../src/wiki/collections.js"
import {
  archivePage,
  createPage,
  movePage,
  requireCommitRules,
  updatePage,
  type WikiCommitOrigin,
  type WikiWrite
} from "../src/wiki/commit.js"
import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "../src/wiki/authority.js"
import { formatRedirectPage } from "../src/wiki/page.js"
import { loadSnapshot } from "../src/wiki/snapshot.js"
import { locateReplayCopy, onCopyMemory, runOnReplayCopy } from "./fixtures/replay-copy.js"
import { withoutSpaces } from "./fixtures/wiki-repository.js"

const located = locateReplayCopy()

const WRITES = [
  "wiki_patch_page",
  "wiki_edit_page",
  "wiki_create_page",
  "wiki_move_page",
  "wiki_restore_page",
  "wiki_archive_page",
  "wiki_merge_page",
  "wiki_apply_patch_set"
] as const

const Paths = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  new_path: Schema.optionalKey(Schema.String),
  edits: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String })))
})

type Writer =
  | "upkeep"
  | "capture"
  | "daily"
  | "other system"
  | "user automation"
  | "chat"
  | "task"
  | "unrecorded"

const writerOf = (originKind: string | null, automationId: string | null): Writer => {
  if (originKind === "chat") return "chat"
  if (originKind === "task") return "task"
  if (originKind !== "automation" || automationId === null) return "unrecorded"
  switch (systemHandlerForAutomation(AutomationId.make(automationId))?.spec.handler) {
    case "wiki_maintenance":
      return "upkeep"
    case "memory_capture":
      return "capture"
    case "daily_summary":
      return "daily"
    case "chat_summaries":
    case "home_letter":
    case "managed_history_collection":
    case "events":
      return "other system"
    case undefined:
      return "user automation"
  }
}

const commitOrigin = (writer: Writer, automationId: string | null): WikiCommitOrigin => {
  switch (writer) {
    case "upkeep":
      return { kind: "upkeep", automationId: automationId ?? "" }
    case "capture":
      return { kind: "capture", sessionId: undefined }
    case "daily":
    case "other system":
    case "user automation":
    case "task":
      return { kind: "automation", automationId: automationId ?? "task" }
    case "chat":
    case "unrecorded":
      return { kind: "agent", sessionId: undefined }
  }
}

type Replayed = "create" | "update" | "move" | "archive" | "merge"

const replayedOperation = Effect.fn("replayedOperation")(function* (
  repository: ManagedFileRepositoryShape,
  tool: (typeof WRITES)[number],
  path: string,
  newPath: string | undefined
) {
  if (tool === "wiki_create_page")
    return { replayed: "create" as const, operation: createPage("replay", path, "") }
  const current = yield* repository.findByPath(path)
  if (current === null) return undefined
  const text = new TextDecoder().decode(yield* repository.readVersion(current))
  const replay = (replayed: Replayed, operation: WikiWrite) => ({ replayed, operation })
  switch (tool) {
    case "wiki_move_page":
      return newPath === undefined ? undefined : replay("move", movePage(current, newPath))
    case "wiki_archive_page":
      return replay("archive", archivePage(current))
    case "wiki_merge_page":
      return replay(
        "merge",
        updatePage(
          current,
          formatRedirectPage({
            pageId: current.resourceId,
            title: path,
            redirectTo: "replay-target"
          })
        )
      )
    case "wiki_patch_page":
    case "wiki_edit_page":
    case "wiki_restore_page":
    case "wiki_apply_patch_set":
      return replay("update", updatePage(current, text))
  }
})

it("classifies every page on the copy, and refuses upkeep's every write to records and others' only by kind", async (context) => {
  if (located.kind === "absent") return context.skip(located.reason)
  const copy = located.copy

  const calls = await runOnReplayCopy(
    copy,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return yield* sql<{
        readonly tool_name: (typeof WRITES)[number]
        readonly arguments_json: string
        readonly origin_kind: string | null
        readonly automation_id: string | null
      }>`
        SELECT t.tool_name, t.arguments_json,
          json_extract(r.metadata_json, '$.run_context.origin.kind') AS origin_kind,
          json_extract(r.metadata_json, '$.run_context.origin.automation_id') AS automation_id
        FROM tool_calls AS t JOIN chat_runs AS r USING (run_id)
        WHERE t.tool_name IN ${sql.in(WRITES)} AND t.status = 'completed'
          AND json_extract(t.result_json, '$.is_error') = 0`
    })
  )

  const outcome = await onCopyMemory(copy, (repository) =>
    Effect.gen(function* () {
      const snapshot = yield* loadSnapshot(repository, "list")
      const active = snapshot.pages.filter(
        (record) => record.resource.state === "active" && record.page.lifecycle === "active"
      )
      const folders = recordFolders(active)
      const kinds = active.map((record) => ({
        record,
        kind: pageKind(folders, record.resource.path)
      }))
      const records = kinds.filter(({ kind }) => kind.kind === "record")
      const pages = {
        active: active.length,
        records: records.length,
        dated: records.filter(({ kind }) => kind.kind === "record" && kind.day !== undefined)
          .length,
        contracts: kinds.filter(({ kind }) => kind.kind === "contract").length,
        knowledge: kinds.filter(({ kind }) => kind.kind === "knowledge").length,
        folders: folders.size,
        markedOutsideFolders: kinds.filter(
          ({ record, kind }) =>
            markedProducer(record.page) !== undefined && kind.kind === "knowledge"
        ).length,
        unmarkedRecords: records.filter(({ record }) => markedProducer(record.page) === undefined)
          .length
      }

      const writes = new Map<
        Writer,
        {
          toRecords: number
          refused: Partial<Record<Replayed, number>>
          refusedElsewhere: number
          updatesRefused: number
          gone: number
        }
      >()
      for (const call of calls) {
        const writer = writerOf(call.origin_kind, call.automation_id)
        const args = Schema.decodeUnknownSync(Schema.fromJsonString(Paths))(call.arguments_json)
        const paths = [args.path, ...(args.edits ?? []).map((edit) => edit.path)]
        for (const path of paths) {
          if (path === undefined) continue
          const counts = writes.get(writer) ?? {
            toRecords: 0,
            refused: {},
            refusedElsewhere: 0,
            updatesRefused: 0,
            gone: 0
          }
          writes.set(writer, counts)
          const replay = yield* replayedOperation(repository, call.tool_name, path, args.new_path)
          if (replay === undefined) {
            counts.gone += 1
            continue
          }
          const toRecord = [path, args.new_path].some(
            (touched) => touched !== undefined && pageKind(folders, touched).kind !== "knowledge"
          )
          const refused = yield* requireCommitRules(
            withoutSpaces(repository),
            {
              origin: commitOrigin(writer, call.automation_id),
              authority: GLOBAL_WIKI_LOCATION_AUTHORITY
            },
            [replay.operation]
          ).pipe(
            Effect.match({
              onFailure: (error) =>
                error._tag === "WikiCommitRuleError" && error.rule === "records",
              onSuccess: () => false
            })
          )
          counts.toRecords += Number(toRecord)
          if (refused && toRecord)
            counts.refused[replay.replayed] = (counts.refused[replay.replayed] ?? 0) + 1
          counts.refusedElsewhere += Number(refused && !toRecord)
          counts.updatesRefused += Number(refused && replay.replayed === "update")
        }
      }
      return { pages, writes: Object.fromEntries([...writes].sort()) }
    })
  )

  process.stdout.write(`\nRecords on the copy:\n${JSON.stringify(outcome, null, 2)}\n`)
  expect(outcome.pages.records + outcome.pages.contracts + outcome.pages.knowledge).toBe(
    outcome.pages.active
  )
  expect(outcome.pages.markedOutsideFolders).toBe(0)
  for (const [writer, counts] of Object.entries(outcome.writes)) {
    const refused = Object.values(counts.refused).reduce((sum, count) => sum + count, 0)
    expect(counts.refusedElsewhere, writer).toBe(0)
    if (writer === "upkeep") expect(refused, writer).toBe(counts.toRecords)
    else expect(counts.updatesRefused, writer).toBe(0)
  }
})
