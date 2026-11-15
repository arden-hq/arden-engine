// Replays a month of the owner's runs and typed turns through the rules that decide what a run
// is sent from Memory, with no model and no write: which runs get a Memory block, by recorded
// actor, and how many short typed turns the recall's word search reads nothing for. It reads
// the database named by ARDEN_MEMORY_BLOCK_REPLAY_DB, opened read-only and immutable, skips
// when the variable is unset or names no file, and prints and asserts counts only.
//
//   ARDEN_MEMORY_BLOCK_REPLAY_DB=<path to arden.db> npx vitest run test/memory-block-replay.test.ts

import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { Schema } from "effect"
import { expect, it } from "vitest"
import { memoryReaderOf } from "../src/context/memory-context.js"
import { RunAuthoritySchema, type RunAuthority } from "../src/execution/authority.js"
import { searchTerms } from "../src/memory/lexical-score.js"
import { recallQuery, recallText } from "../src/memory/retrieval.js"
import { authoredText, isHumanMessage } from "../src/persistence/transcript/content.js"

const DATABASE = process.env["ARDEN_MEMORY_BLOCK_REPLAY_DB"]?.trim() ?? ""
// The month the rebuild plan measured.
const FROM = "2026-10-14T00:00:00.000Z"
const UNTIL = "2026-11-14T00:00:00.000Z"
// The recall's word search reads nothing under this many characters (retrieval.ts).
const MIN_QUERY_LENGTH = 12

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

/** Whether the word search reads anything of this query. */
const searches = (query: string): boolean => {
  const text = recallQuery(query).toLocaleLowerCase().split(/\s+/u).filter(Boolean).join(" ")
  return text.length >= MIN_QUERY_LENGTH && searchTerms(text).size > 0
}

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
        // Before: a chat a person started (no Automation origin, not a helper's chat).
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
             WHERE m.role = 'user' AND s.session_type != 'agent' AND m.created_at < ?
             ORDER BY m.session_id, m.seq`
          )
          .all(UNTIL)
      )
      const typedSoFar = new Map<string, Array<string>>()
      let short = 0
      let shortSearchingNothingBefore = 0
      let shortSearchingNothingAfter = 0
      for (const row of messages) {
        const message: unknown = JSON.parse(row.message_json)
        if (typeof message !== "object" || message === null || !("role" in message)) continue
        const envelope = { ...message, role: String(message.role) }
        if (!isHumanMessage(envelope)) continue
        const text = authoredText("content" in message ? message.content : undefined)
        const earlier = typedSoFar.get(row.session_id) ?? []
        typedSoFar.set(row.session_id, [...earlier, text])
        if (row.created_at < FROM) continue
        if (searches(text) || recallQuery(text).trim().length >= MIN_QUERY_LENGTH) continue
        short += 1
        if (!searches(text)) shortSearchingNothingBefore += 1
        if (!searches(recallText([text, ...earlier.toReversed()]))) shortSearchingNothingAfter += 1
      }

      const rows = [...byActor].toSorted(([left], [right]) => left.localeCompare(right))
      process.stdout.write(
        [
          "",
          `Runs ${FROM.slice(0, 10)} to ${UNTIL.slice(0, 10)} by recorded actor: runs, sent a Memory block before, after.`,
          ...rows.map(([key, row]) => `  ${key}: ${row.runs}, ${row.before}, ${row.after}`),
          `Short typed turns: ${short}; the word search read nothing for ${shortSearchingNothingBefore} before, ${shortSearchingNothingAfter} after.`,
          ""
        ].join("\n")
      )
      expect(runs.length).toBeGreaterThan(0)
      for (const [key, row] of rows)
        if (key.endsWith("automation") || key === "helper of automation") expect(row.after).toBe(0)
        else expect(row.after).toBe(row.runs)
      expect(shortSearchingNothingAfter).toBeLessThanOrEqual(shortSearchingNothingBefore)
    } finally {
      database.close()
    }
  }
)
