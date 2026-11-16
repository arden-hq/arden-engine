import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { Schema } from "effect"
import { expect, it } from "vitest"
import { memoryReaderOf } from "../src/context/memory-context.js"
import { RunAuthoritySchema, type RunAuthority } from "../src/execution/authority.js"
import { wordSearchTerms } from "../src/memory/retrieval.js"
import { authoredText, isHumanMessage } from "../src/persistence/transcript/content.js"

const DATABASE = process.env["ARDEN_MEMORY_BLOCK_REPLAY_DB"]?.trim() ?? ""
const FROM = "2026-10-14T00:00:00.000Z"
const UNTIL = "2026-11-14T00:00:00.000Z"

const decodeAuthority = Schema.decodeUnknownSync(Schema.fromJsonString(RunAuthoritySchema))

const RunRows = Schema.Array(
  Schema.Struct({
    authority_json: Schema.String,
    session_type: Schema.NullOr(Schema.String),
    origin_automation_id: Schema.NullOr(Schema.String)
  })
)
const MessageRows = Schema.Array(
  Schema.Struct({
    session_id: Schema.String,
    created_at: Schema.String,
    message_json: Schema.String
  })
)

const actorLabel = (actor: RunAuthority["actor"]): string => {
  if (actor.kind === "agent") return `helper of ${actor.root}`
  if (actor.kind !== "automation") return actor.kind
  return `${actor.purpose === "user_automation" ? "owner" : "system"} automation`
}

const searches = (query: string): boolean => wordSearchTerms(query).size > 0

it.skipIf(DATABASE === "" || !existsSync(DATABASE))(
  "a month of runs and typed turns through the Memory block's rules",
  () => {
    const database = new DatabaseSync(`file:${DATABASE}?mode=ro&immutable=1`, { readOnly: true })
    try {
      const runs = Schema.decodeUnknownSync(RunRows)(
        database
          .prepare(
            `SELECT r.authority_json, s.session_type, s.origin_automation_id
             FROM chat_runs r LEFT JOIN sessions s ON s.session_id = r.session_id
             WHERE r.started_at >= ? AND r.started_at < ? AND r.authority_json IS NOT NULL`
          )
          .all(FROM, UNTIL)
      )
      const byActor = new Map<string, { runs: number; before: number; after: number }>()
      for (const run of runs) {
        const actor = decodeAuthority(run.authority_json).actor
        const key = actorLabel(actor)
        const row = byActor.get(key) ?? { runs: 0, before: 0, after: 0 }
        row.runs += 1
        if (
          run.session_type !== "agent" &&
          run.origin_automation_id === null &&
          actor.kind === "person"
        )
          row.before += 1
        if (memoryReaderOf(actor) !== undefined) row.after += 1
        byActor.set(key, row)
      }

      const messages = Schema.decodeUnknownSync(MessageRows)(
        database
          .prepare(
            `SELECT m.session_id, m.created_at, m.message_json
             FROM session_messages m JOIN sessions s ON s.session_id = m.session_id
             WHERE m.role = 'user' AND s.session_type != 'agent'
               AND m.created_at >= ? AND m.created_at < ?`
          )
          .all(FROM, UNTIL)
      )
      let typed = 0
      let short = 0
      for (const row of messages) {
        const message: unknown = JSON.parse(row.message_json)
        if (typeof message !== "object" || message === null || !("role" in message)) continue
        const envelope = { ...message, role: String(message.role) }
        if (!isHumanMessage(envelope)) continue
        const text = authoredText("content" in message ? message.content : undefined)
        if (text.trim() === "") continue
        typed += 1
        if (!searches(text)) short += 1
      }

      const rows = [...byActor].toSorted(([left], [right]) => left.localeCompare(right))
      process.stdout.write(
        [
          "",
          `Runs ${FROM.slice(0, 10)} to ${UNTIL.slice(0, 10)} by recorded actor: runs, sent a Memory block before, after.`,
          ...rows.map(([key, row]) => `  ${key}: ${row.runs}, ${row.before}, ${row.after}`),
          `Typed turns: ${typed}; the word search reads nothing of ${short}.`,
          ""
        ].join("\n")
      )
      expect(runs.length).toBeGreaterThan(0)
      for (const [key, row] of rows) expect(row.after).toBe(key === "person" ? row.runs : 0)
      expect(short).toBeLessThanOrEqual(typed)
    } finally {
      database.close()
    }
  }
)
