import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { Effect, Option } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { EvidenceInput, RecordedEvidence } from "../work/contract.js"
import type { WorkStoreError } from "../work/store.js"
import { workError } from "./work-records.js"

export const resolveEvidence = Effect.fn("TaskContract.resolveEvidence")(function* (options: {
  readonly sql: SqlClient.SqlClient
  readonly itemId: string
  readonly evidence: EvidenceInput
  readonly after: string
}): Effect.fn.Return<RecordedEvidence, WorkStoreError> {
  const { sql, itemId, evidence, after } = options
  const tooOld = `It predates the criterion (saved ${after}); cite work done since.`
  const read = <A>(effect: Effect.Effect<A, unknown>) =>
    effect.pipe(Effect.mapError((cause) => workError("storage", "Could not read evidence", cause)))
  const ofThisTask = sql`EXISTS (SELECT 1 FROM chat_runs AS run WHERE run.run_id = call.run_id
    AND (json_extract(run.metadata_json, '$.run_context.task.item_id') = ${itemId}
      OR run.session_id = (SELECT home_session_id FROM space_tasks
        WHERE item_id = ${itemId} AND runs_in = 'chat')))`
  switch (evidence.kind) {
    case "tool_call": {
      const rows = yield* read(sql<{
        readonly run_id: string
        readonly tool_name: string
        readonly status: string
        readonly effect: string | null
        readonly is_error: number | null
        readonly exit_code: number | null
      }>`SELECT call.run_id, call.tool_name, call.status, call.effect,
          json_extract(call.result_json, '$.is_error') AS is_error,
          json_extract(call.result_json, '$.data.exit_code') AS exit_code
        FROM tool_calls AS call
        WHERE call.tool_call_id = ${evidence.tool_call_id} AND ${ofThisTask}
          AND call.started_at > ${after}
        ORDER BY call.started_at DESC LIMIT 1`)
      const call = rows[0]
      if (call === undefined)
        return yield* refuse(
          `No run of this Task made tool call ${evidence.tool_call_id} after the criterion was saved (${after}). Cite a call one of its runs made since.`
        )
      if (call.status !== "completed")
        return yield* refuse(
          `Tool call ${evidence.tool_call_id} has not finished (${call.status}).`
        )
      if (call.is_error === 1)
        return yield* refuse(
          `Tool call ${evidence.tool_call_id} failed; a failed call proves nothing.`
        )
      if (call.effect === "run_record" || call.tool_name.startsWith("task_"))
        return yield* refuse(
          `${call.tool_name} only records what a run says. Cite the call that did the work.`
        )
      if (!COMMAND_TOOLS.has(call.tool_name))
        return { kind: "tool_call", tool_call_id: evidence.tool_call_id, tool_name: call.tool_name }
      if (call.exit_code !== 0)
        return yield* refuse(
          `Command call ${evidence.tool_call_id} has no exit code 0 recorded: it is still running or it failed. Cite it once it exits 0.`
        )
      return {
        kind: "tool_call",
        tool_call_id: evidence.tool_call_id,
        tool_name: call.tool_name,
        exit_code: 0
      }
    }
    case "file": {
      if (!isAbsolute(evidence.path))
        return yield* refuse(`Give the file's absolute path, not ${JSON.stringify(evidence.path)}.`)
      const found = yield* Effect.tryPromise(() => stat(evidence.path)).pipe(
        Effect.option,
        Effect.map(Option.getOrUndefined)
      )
      if (found === undefined) return yield* refuse(`No file exists at ${evidence.path}.`)
      const modifiedAt = found.mtime.toISOString()
      if (modifiedAt <= after)
        return yield* refuse(`${evidence.path} was last changed ${modifiedAt}. ${tooOld}`)
      return { kind: "file", path: evidence.path, size: found.size, modified_at: modifiedAt }
    }
    case "attachment": {
      const rows = yield* read(sql<{
        readonly name: string
        readonly created_at: string
      }>`SELECT name, created_at FROM space_task_attachments
        WHERE attachment_id = ${evidence.attachment_id} AND item_id = ${itemId} AND size > 0`)
      const saved = rows[0]
      if (saved === undefined)
        return yield* refuse(
          `This Task has no saved result with attachment ID ${evidence.attachment_id}.`
        )
      if (saved.created_at <= after)
        return yield* refuse(
          `${JSON.stringify(saved.name)} was saved ${saved.created_at}. ${tooOld}`
        )
      return { kind: "attachment", attachment_id: evidence.attachment_id, name: saved.name }
    }
    case "url": {
      const url = canonicalUrl(evidence.url)
      if (url === undefined) return yield* refuse(`${JSON.stringify(evidence.url)} is not a URL.`)
      const rows = yield* read(sql<{ readonly tool_call_id: string }>`SELECT call.tool_call_id
        FROM tool_calls AS call
        WHERE call.tool_name = 'web_fetch' AND call.status = 'completed'
          AND COALESCE(json_extract(call.result_json, '$.is_error'), 0) = 0
          AND (json_extract(call.result_json, '$.data.requested_url') = ${url}
            OR json_extract(call.result_json, '$.data.final_url') = ${url})
          AND ${ofThisTask} AND call.started_at > ${after}
        ORDER BY call.started_at DESC LIMIT 1`)
      const fetched = rows[0]
      if (fetched === undefined)
        return yield* refuse(
          `No run of this Task fetched ${url} successfully since the criterion was saved (${after}). Fetch it with web_fetch, then cite it.`
        )
      return { kind: "url", url, tool_call_id: fetched.tool_call_id }
    }
  }
})

const COMMAND_TOOLS: ReadonlySet<string> = new Set(["exec_command", "write_stdin"])

const refuse = (reason: string) => Effect.fail(workError("invalid", reason))

const canonicalUrl = (value: string): string | undefined =>
  URL.canParse(value) ? new URL(value).toString() : undefined
