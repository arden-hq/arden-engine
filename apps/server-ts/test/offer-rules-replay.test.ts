import { existsSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SpaceTaskSourceSchema } from "@arden-hq/protocol/effect/spaces/work"
import type { SpaceTaskSource } from "@arden-hq/protocol/spaces/work"
import { Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, it } from "vitest"
import { ownerDataDirectory } from "../src/config/service.js"
import { TaskProposalStore } from "../src/persistence/proposals/store.js"
import {
  ownerTurnFingerprint,
  settledFingerprint,
  type ChatSettledState
} from "../src/persistence/sqlite/chat-ownership.js"
import {
  citedTurnFinished,
  offerAnchorRefusal,
  storedOfferStands
} from "../src/persistence/sqlite/offer-rules.js"
import { evidenceKey } from "../src/persistence/sqlite/proposal-evidence.js"
import { withTempDatabase } from "./fixtures/temp-database.js"

// The offer rules over the owner's real history, with no model and no server. The database is
// opened read-only and immutable, so nothing in it can change; only counts leave this file. The
// expiry replay copies the open Home offers into a temporary database that is deleted after.
// Skips where the database is absent.

const DATABASE = join(ownerDataDirectory(), "arden.db")
const present = existsSync(DATABASE)

type Row = Record<string, unknown>

const text = (row: Row, key: string): string => {
  const value = row[key]
  if (typeof value !== "string") throw new Error(`${key} is not text`)
  return value
}
const maybe = (row: Row, key: string): string | null => {
  const value = row[key]
  return typeof value === "string" ? value : null
}

const decodeSources = Schema.decodeUnknownSync(Schema.Array(SpaceTaskSourceSchema))
const decodeArguments = Schema.decodeUnknownSync(
  Schema.Struct({ sources: Schema.optional(Schema.Array(Schema.Unknown)) })
)
const CitedChat = Schema.Struct({
  kind: Schema.Literal("chat"),
  session_id: Schema.String,
  turn_id: Schema.String
})

const withDatabase = <A>(use: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(`file:${DATABASE}?mode=ro&immutable=1`, { readOnly: true })
  try {
    return use(database)
  } finally {
    database.close()
  }
}

/** A run's status as it stood at `at`, or undefined when it had not started. */
const statusAt = (run: Row, at: string): string | undefined => {
  if (text(run, "started_at") > at) return undefined
  const ended = maybe(run, "ended_at")
  return ended !== null && ended <= at ? text(run, "status") : "running"
}

/** Each owner chat of a Space as the review's chat query would have seen it at `at`. Queued
 * messages are not kept in history, so `pending` is 0. */
const chatsAt = (database: DatabaseSync, spaceId: string, at: string): ChatSettledState[] =>
  database
    .prepare(`SELECT session_id, public_ref, name FROM sessions WHERE space_id = ?
      AND session_type = 'chat' AND origin_automation_id IS NULL ORDER BY session_id`)
    .all(spaceId)
    .map((chat) => {
      const runs = database
        .prepare(`SELECT run.run_id, run.status, run.started_at, run.ended_at,
            json_extract(run.metadata_json, '$.turn_id') AS turn_id,
            json_extract(run.metadata_json, '$.automation') IS NULL
              AND json_extract(COALESCE(request.message_json, message.message_json), '$.is_meta') IS NOT 1
              AND request.run_id IS NOT NULL AS owner
          FROM chat_runs AS run
          LEFT JOIN chat_idempotency_keys AS request ON request.session_id = run.session_id
            AND request.client_id = run.client_id AND request.run_id = run.run_id
          LEFT JOIN session_messages AS message ON message.session_id = request.session_id
            AND message.message_id = request.message_id
          WHERE run.session_id = ? AND run.started_at <= ?
          ORDER BY run.started_at DESC, run.run_id DESC`)
        .all(text(chat, "session_id"), at)
      const latest = runs[0]
      const active = runs.filter((run) => statusAt(run, at) === "running").length
      return {
        session_id: text(chat, "session_id"),
        session_ref: text(chat, "public_ref"),
        title: maybe(chat, "name"),
        run_id: latest === undefined ? null : text(latest, "run_id"),
        turn_id: latest === undefined ? null : maybe(latest, "turn_id"),
        status: latest === undefined ? null : (statusAt(latest, at) ?? null),
        owner_turn_id: maybe(runs.find((run) => run["owner"] === 1) ?? {}, "turn_id"),
        pending: 0,
        settled: active === 0
      }
    })

const turnStatusesAt = (database: DatabaseSync, source: SpaceTaskSource, at: string) =>
  source.kind !== "chat"
    ? []
    : database
        .prepare(`SELECT status, started_at, ended_at FROM chat_runs
          WHERE session_id = ? AND json_extract(metadata_json, '$.turn_id') = ?`)
        .all(source.session_id, source.turn_id)
        .flatMap((run) => {
          const status = statusAt(run, at)
          return status === undefined ? [] : [status]
        })

/** Today's rule: the cited turn is the chat's latest turn, and the chat is idle. */
const lastTurnRule = (
  chats: ReadonlyArray<ChatSettledState>,
  sources: ReadonlyArray<SpaceTaskSource>
) =>
  sources.every(
    (source) =>
      source.kind !== "chat" ||
      chats.some(
        (chat) =>
          chat.session_id === source.session_id && chat.settled && chat.turn_id === source.turn_id
      )
  )

const finishedRule = (
  database: DatabaseSync,
  sources: ReadonlyArray<SpaceTaskSource>,
  at: string
) =>
  sources.every(
    (source) => source.kind !== "chat" || citedTurnFinished(turnStatusesAt(database, source, at))
  )

it.skipIf(!present)(
  "replays the offer rules over the real history: counts only",
  async () => {
    const replay = withDatabase((database) => {
      // Every Space offer call that cited a chat turn, with the run's Space and the call time.
      const calls = database
        .prepare(`SELECT call.started_at, call.arguments_json,
            json_extract(call.result_json, '$.is_error') AS failed,
            COALESCE(json_extract(call.result_json, '$.content'), '') AS message,
            (SELECT MAX(review.started_at) FROM tool_calls AS review WHERE review.run_id = call.run_id
              AND review.tool_name = 'space_inference_review' AND review.started_at < call.started_at)
              AS reviewed_at,
            json_extract(run.metadata_json, '$.run_context.origin.space_id') AS space_id
          FROM tool_calls AS call JOIN chat_runs AS run ON run.run_id = call.run_id
          WHERE call.tool_name = 'task_propose'
            AND json_extract(call.arguments_json, '$.decision.kind') IN ('create', 'revise')
            AND json_extract(run.metadata_json, '$.run_context.origin.kind') = 'space'
          ORDER BY call.started_at`)
        .all()
        .map((call) => {
          const cited = decodeArguments(JSON.parse(text(call, "arguments_json"))).sources ?? []
          const sources = cited.flatMap((source) => {
            const chat = Schema.decodeUnknownOption(CitedChat)(source)
            return Option.isSome(chat)
              ? decodeSources([{ ...chat.value, revision: chat.value.turn_id }])
              : []
          })
          return { call, sources }
        })

      const lastTurnRefused = calls.filter(({ call }) =>
        text(call, "message").startsWith("Chat evidence is unfinished")
      )
      const lastTurn = {
        refused: lastTurnRefused.length,
        oldRuleRefuses: lastTurnRefused.filter(
          ({ call, sources }) =>
            !lastTurnRule(
              chatsAt(database, text(call, "space_id"), text(call, "started_at")),
              sources
            )
        ).length,
        newRuleAdmits: lastTurnRefused.filter(({ call, sources }) =>
          finishedRule(database, sources, text(call, "started_at"))
        ).length
      }

      const snapshotRefused = calls.filter(({ call }) =>
        / work changed since review/u.test(text(call, "message"))
      )
      const chatPart = (fingerprint: typeof ownerTurnFingerprint | typeof settledFingerprint) =>
        snapshotRefused.filter(({ call }) => {
          const spaceId = text(call, "space_id")
          const reviewed = text(call, "reviewed_at")
          return (
            JSON.stringify(fingerprint(chatsAt(database, spaceId, reviewed))) !==
            JSON.stringify(fingerprint(chatsAt(database, spaceId, text(call, "started_at"))))
          )
        }).length
      const otherChanges = snapshotRefused.filter(({ call }) => {
        const [changes] = database
          .prepare(`SELECT
              (SELECT COUNT(*) FROM space_task_revisions AS revision
                JOIN space_tasks AS task ON task.item_id = revision.item_id
                WHERE task.space_id = ?1 AND revision.recorded_at > ?2 AND revision.recorded_at <= ?3)
              + (SELECT COUNT(*) FROM task_proposal_revisions AS revision
                JOIN task_proposals AS proposal ON proposal.proposal_id = revision.proposal_id
                WHERE proposal.space_id = ?1 AND revision.recorded_at > ?2 AND revision.recorded_at <= ?3)
              AS changes`)
          .all(text(call, "space_id"), text(call, "reviewed_at"), text(call, "started_at"))
        return changes?.["changes"] !== 0
      }).length
      const snapshot = {
        refused: snapshotRefused.length,
        oldChatPartChanged: chatPart(settledFingerprint),
        newChatPartChanged: chatPart(ownerTurnFingerprint),
        tasksOrOffersChanged: otherChanges
      }

      // The accepted Space offers, through the anchor and chat-turn rules at the time they were made.
      const accepted = database
        .prepare(`SELECT proposal.sources_json, call.started_at FROM task_proposals AS proposal
          JOIN tool_calls AS call ON call.run_id = proposal.source_run_id
            AND call.tool_call_id = proposal.source_tool_call_id
          WHERE proposal.place = 'space' AND proposal.status = 'accepted'`)
        .all()
        .map((row) => ({
          sources: decodeSources(JSON.parse(text(row, "sources_json"))),
          at: text(row, "started_at")
        }))
      const admitted = {
        accepted: accepted.length,
        admitted: accepted.filter(
          ({ sources, at }) =>
            offerAnchorRefusal(sources) === undefined && finishedRule(database, sources, at)
        ).length,
        pageOnly: accepted.filter(({ sources }) => offerAnchorRefusal(sources) !== undefined).length
      }

      // Every rejected Space offer, asked again after each Memory page it cites changed. Home
      // offers from mail carry no computed evidence key, and cite no page.
      const rejected = database
        .prepare(`SELECT sources_json, evidence_revision_key, candidate_hash FROM task_proposals
          WHERE status = 'rejected' AND place = 'space'`)
        .all()
        .map((row) => {
          const sources = decodeSources(JSON.parse(text(row, "sources_json")))
          const edited = sources.map((source) =>
            source.kind === "memory" ? { ...source, revision: `${source.revision}-edited` } : source
          )
          const call = { evidenceKey: evidenceKey(edited), candidateHash: "asked-again" }
          const stored = {
            status: "rejected" as const,
            evidence_revision_key: text(row, "evidence_revision_key"),
            candidate_hash: text(row, "candidate_hash"),
            retired_evidence_key: null
          }
          return {
            keyMatches: evidenceKey(sources) === stored.evidence_revision_key,
            citesPage: sources.some((source) => source.kind === "memory"),
            oldRuleReopens: stored.evidence_revision_key !== call.evidenceKey,
            newRuleReopens: !storedOfferStands(stored, call),
            pageOnly: offerAnchorRefusal(sources) !== undefined
          }
        })
      // Offers that really came back after a No: a stored revision rejected, the next one offered.
      const [cameBack] = database
        .prepare(`SELECT COUNT(*) AS count FROM task_proposal_revisions AS before
          JOIN task_proposal_revisions AS after ON after.proposal_id = before.proposal_id
            AND after.version = before.version + 1
          WHERE json_extract(before.state_json, '$.status') = 'rejected'
            AND json_extract(after.state_json, '$.status') = 'offered'`)
        .all()
      const noStaysNo = {
        rejected: rejected.length,
        keyMatches: rejected.filter((row) => row.keyMatches).length,
        citingPage: rejected.filter((row) => row.citesPage).length,
        oldRuleReopens: rejected.filter((row) => row.oldRuleReopens).length,
        newRuleReopens: rejected.filter((row) => row.newRuleReopens).length,
        pageOnly: rejected.filter((row) => row.pageOnly).length,
        cameBackAfterNo: cameBack?.["count"]
      }

      // The stopped inferred Tasks the review now lists in place of the dropped table decode.
      const stopped = database
        .prepare(`SELECT COALESCE((SELECT json_group_array(json(source.source))
            FROM space_task_sources AS source WHERE source.item_id = task.item_id), '[]') AS sources
          FROM space_tasks AS task WHERE task.status = 'cancelled'
            AND json_extract(task.capture, '$.basis') = 'inferred'`)
        .all()
      const undecodable = stopped.filter((row) =>
        Option.isNone(
          Schema.decodeUnknownOption(Schema.Array(SpaceTaskSourceSchema))(
            JSON.parse(text(row, "sources"))
          )
        )
      ).length
      const [deadRows] = database
        .prepare(`SELECT COUNT(*) AS rows, SUM(EXISTS (SELECT 1 FROM space_tasks AS task
            WHERE task.item_id = dead.item_id AND task.status = 'cancelled'
              AND json_extract(task.capture, '$.basis') = 'inferred')) AS kept
          FROM task_inference_rejections AS dead`)
        .all()

      const open = database
        .prepare(
          `SELECT * FROM task_proposals WHERE place = 'home' AND status IN ('offered', 'held')`
        )
        .all()
      return {
        lastTurn,
        snapshot,
        admitted,
        noStaysNo,
        stopped: stopped.length,
        undecodable,
        deadRows,
        open
      }
    })

    const expiry = await withTempDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const proposals = yield* TaskProposalStore
        for (const row of replay.open) yield* sql`INSERT INTO task_proposals ${sql.insert(row)}`
        const count = () =>
          sql<{ readonly status: string; readonly count: number }>`SELECT status, COUNT(*) AS count
            FROM task_proposals GROUP BY status ORDER BY status`
        const before = yield* count()
        const expired = yield* proposals.expireOffers()
        const after = yield* count()
        const [started] = yield* sql<{ readonly runs: number; readonly jobs: number }>`SELECT
          (SELECT COUNT(*) FROM chat_runs) AS runs,
          (SELECT COUNT(*) FROM automation_event_queue) AS jobs`
        return { before, expired, after, started }
      })
    )

    process.stdout.write(
      `Offer replay: ${JSON.stringify({ ...replay, open: replay.open.length, expiry })}\n`
    )
    // (a) Every call refused by the last-turn check cited a finished turn; the old rule still
    // refuses each, the new rule admits each.
    expect(replay.lastTurn.refused).toBeGreaterThan(0)
    expect(replay.lastTurn.oldRuleRefuses).toBe(replay.lastTurn.refused)
    expect(replay.lastTurn.newRuleAdmits).toBe(replay.lastTurn.refused)
    // A result or run landing mid-review no longer changes the snapshot; no owner turn,
    // Task or offer changed in those windows.
    expect(replay.snapshot.newChatPartChanged).toBe(0)
    expect(replay.snapshot.tasksOrOffersChanged).toBe(0)
    // (d) Every accepted Space offer that cited a chat turn or a mail is still admitted.
    expect(replay.admitted.admitted + replay.admitted.pageOnly).toBe(replay.admitted.accepted)
    // (c) A No stays a No when a cited page changes.
    expect(replay.noStaysNo.keyMatches).toBe(replay.noStaysNo.rejected)
    expect(replay.noStaysNo.newRuleReopens).toBe(0)
    expect(replay.noStaysNo.oldRuleReopens).toBe(replay.noStaysNo.citingPage)
    // The dropped table's rows all name a cancelled inferred Task the review still lists.
    expect(replay.deadRows?.["kept"]).toBe(replay.deadRows?.["rows"])
    expect(replay.undecodable).toBe(0)
    // (b) Old Home offers expire, held ones move up, and nothing starts.
    expect(expiry.expired).toBe(expiry.before.find((row) => row.status === "offered")?.count)
    expect(expiry.after.find((row) => row.status === "offered")?.count).toBeGreaterThan(0)
    expect(expiry.started).toEqual({ runs: 0, jobs: 0 })
  },
  600_000
)
