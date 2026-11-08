import { DateTime, Effect, Schema } from "effect"
import type { SqlError } from "effect/unstable/sql"
import {
  HomeEvidenceSchema,
  HomeLetterBodySchema,
  HomeLetterResponseSchema,
  HomePresenceInputSchema
} from "@arden-hq/protocol/effect/runs"
import type { HomeEvidence } from "@arden-hq/protocol/runs"
import { HOME_LETTER_AUTOMATION_ID } from "../automations/model.js"
import { WorkStoreError } from "../work/store.js"
import { HomeStore, type HomeLetterSnapshot } from "../home/store.js"
import type { HomeAddressBook, HomeAddressNeeds, HomeLetterRules } from "../home/model.js"
import { makeHomeEvidence } from "./home-evidence.js"
import { decodeJson } from "./json.js"
import { workError } from "./work-records.js"
import { nextId } from "./deps.js"
import type { PersistenceDeps } from "./deps.js"
import { iso } from "../../runtime/clock.js"
import { sha256Hex } from "@arden-hq/std/hash"

const PRESENCE_LEASE_MS = 30_000

const withQuestionDestinations = (text: unknown): unknown => {
  if (typeof text !== "string") return text
  const fill = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fill)
    if (value === null || typeof value !== "object") return value
    const record = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, fill(entry)])
    )
    return "question_id" in record &&
      typeof record["session_id"] === "string" &&
      !("destination_session_id" in record)
      ? { ...record, destination_session_id: record["session_id"] }
      : record
  }
  try {
    return JSON.stringify(fill(JSON.parse(text)))
  } catch {
    return text
  }
}
const LETTERS_KEPT = 28
interface HomeRow {
  readonly window_id: string
  readonly window_since: string
  readonly last_seen_at: string | null
  readonly source_fingerprint: string | null
  readonly run_id: string | null
  readonly generated_at: string | null
  readonly body_json: string | null
  readonly sources_json: string | null
  readonly snapshot_json: string | null
}
interface LetterRow {
  readonly run_id: string
  readonly window_since: string
  readonly window_through: string
  readonly generated_at: string
  readonly body_json: string
  readonly sources_json: string
}

export const makeHomeStore = ({
  writer,
  reader
}: Pick<PersistenceDeps, "writer" | "reader">): HomeStore["Service"] => {
  const sql = writer.sql
  const evidence = makeHomeEvidence({ sql, consistent: (read) => read })
  const viewEvidence = makeHomeEvidence({ sql: reader, consistent: writer.snapshot })
  const transaction = <A, E>(operation: Effect.Effect<A, E>) =>
    writer
      .transact(operation)
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof WorkStoreError
            ? cause
            : workError("storage", "Could not update Home letter", cause)
        )
      )
  const read = <A, E>(operation: Effect.Effect<A, E>) =>
    operation.pipe(
      Effect.mapError((cause) =>
        cause instanceof WorkStoreError
          ? cause
          : workError("storage", "Could not read Home letter", cause)
      )
    )
  const state = Effect.fn(function* () {
    const now = DateTime.formatIso(yield* DateTime.now)
    yield* sql`INSERT INTO home_letter (singleton_id, window_id, window_since, created_at)
      VALUES (1, ${yield* nextId}, ${now}, ${now}) ON CONFLICT(singleton_id) DO NOTHING`
    const rows = yield* sql<HomeRow>`SELECT * FROM home_letter WHERE singleton_id = 1`
    if (!rows[0]) return yield* workError("storage", "Home state is missing")
    return rows[0]
  })

  const collect = Effect.fn(function* (rules: HomeLetterRules) {
    const window = yield* state()
    const first = yield* evidence({ since: window.window_since })
    const entries: HomeEvidence[] = [...first.entries]
    let cursor = first.next_cursor
    while (cursor !== null) {
      const page = yield* evidence({ since: window.window_since, cursor })
      entries.push(...page.entries)
      cursor = page.next_cursor
    }
    const jobs = yield* sql<{
      readonly prompt: string
    }>`SELECT prompt FROM scheduled_tasks WHERE task_id = ${HOME_LETTER_AUTOMATION_ID}`
    return {
      window: { id: window.window_id, since: window.window_since },
      through: first.window.through,
      headline: first.headline,
      entries,
      instruction: jobs[0]?.prompt ?? rules.instruction
    }
  })
  const taskState = Effect.fn("Home.taskState")(function* (entries: readonly HomeEvidence[]) {
    const ids = new Set(
      entries.flatMap((entry) => {
        if (entry.kind === "task") return [entry.item_id]
        if (entry.kind === "offer") return []
        const task = entry.kind === "question" ? entry.question.context.task : entry.context?.task
        return task === null || task === undefined ? [] : [task.item_id]
      })
    )
    if (ids.size === 0) return []
    const rows = yield* sql<{ readonly item_id: string; readonly value: string }>`
      SELECT task.item_id, json_array(task.text, task.status, task.owner, task.blocked, task.waiting_on,
        task.due_at, task.generation, space.archived_at, task.body,
        (SELECT MAX(event_id) FROM space_task_events WHERE item_id = task.item_id AND event_type <> 'scheduled')) AS value
      FROM space_tasks AS task LEFT JOIN spaces AS space ON space.space_id = task.space_id
      WHERE task.item_id IN ${sql.in([...ids])} ORDER BY task.item_id`
    return rows.map((row) => ({
      item_id: row.item_id,
      version: sha256Hex(row.value)
    }))
  })
  const snapshot = Effect.fn("Home.snapshot")(function* (
    rules: HomeLetterRules
  ): Effect.fn.Return<HomeLetterSnapshot, WorkStoreError | SqlError.SqlError> {
    const current = yield* collect(rules)
    const entries = rules.select(current.entries)
    const prepared = { ...current, entries, task_state: yield* taskState(entries) }
    return { ...prepared, fingerprint: rules.fingerprint(prepared) }
  })
  const addressBook = Effect.fn("Home.addressBook")(function* (needs: HomeAddressNeeds) {
    const sessions =
      needs.sessionIds.length === 0
        ? []
        : yield* sql<{ readonly session_id: string; readonly public_ref: string }>`
      SELECT session_id, public_ref FROM sessions WHERE session_id IN ${sql.in(needs.sessionIds)}`
    const runs =
      needs.runIds.length === 0
        ? []
        : yield* sql<{ readonly run_id: string; readonly turn_id: string | null }>`
      SELECT run_id, json_extract(metadata_json, '$.turn_id') AS turn_id FROM chat_runs WHERE run_id IN ${sql.in(needs.runIds)}`
    return {
      sessionRefs: new Map(sessions.map((row) => [row.session_id, row.public_ref])),
      runTurns: new Map(
        runs.flatMap((row) => (row.turn_id === null ? [] : [[row.run_id, row.turn_id] as const]))
      )
    } satisfies HomeAddressBook
  })
  const validSnapshot = Effect.fn("Home.validSnapshot")(function* (
    saved: HomeLetterSnapshot,
    current: Omit<HomeLetterSnapshot, "fingerprint" | "task_state">,
    rules: HomeLetterRules
  ) {
    if (saved.window.id !== current.window.id || saved.instruction !== current.instruction)
      return false
    const evidenceById = new Map(
      current.entries.map((entry) => [entry.id, JSON.stringify(rules.normalize(entry))])
    )
    if (saved.entries.some((entry) => evidenceById.get(entry.id) !== JSON.stringify(entry)))
      return false
    return JSON.stringify(saved.task_state) === JSON.stringify(yield* taskState(saved.entries))
  })

  return HomeStore.of({
    homeEvidence: viewEvidence,
    homePresence: Effect.fn("WorkStore.homePresence")(function* (input) {
      const valid = yield* Schema.decodeUnknownEffect(HomePresenceInputSchema)(input).pipe(
        Effect.mapError((cause) => workError("invalid", "Invalid Home presence", cause))
      )
      return yield* transaction(
        Effect.gen(function* () {
          yield* state()
          const now = DateTime.formatIso(yield* DateTime.now)
          const clients = yield* sql<{
            readonly sequence: number
          }>`SELECT sequence FROM home_presence WHERE client_id = ${valid.client_id}`
          if (clients[0] && clients[0].sequence >= valid.sequence) return
          if (valid.active)
            yield* sql`UPDATE home_letter SET last_seen_at = ${now} WHERE singleton_id = 1`
          const lease = valid.active ? iso(Date.parse(now) + PRESENCE_LEASE_MS) : now
          yield* sql`INSERT INTO home_presence (client_id, sequence, last_seen_at, lease_until)
          VALUES (${valid.client_id}, ${valid.sequence}, ${valid.active ? now : null}, ${lease})
          ON CONFLICT(client_id) DO UPDATE SET sequence = excluded.sequence, lease_until = excluded.lease_until,
            last_seen_at = COALESCE(excluded.last_seen_at, home_presence.last_seen_at)`
        })
      )
    }),
    homeLetterSnapshot: (rules) => transaction(snapshot(rules)),
    homeLetter: () =>
      read(
        Effect.gen(function* () {
          const stored = yield* sql<HomeRow>`SELECT * FROM home_letter WHERE singleton_id = 1`
          const window = stored[0] ?? (yield* transaction(state()))
          const first = yield* viewEvidence({ since: window.window_since })
          const current = {
            window: { id: window.window_id, since: window.window_since },
            headline: first.headline
          }
          const rows =
            yield* sql<LetterRow>`SELECT run_id, window_since, window_through, generated_at, body_json, sources_json
        FROM home_letters ORDER BY generated_at DESC, letter_id DESC LIMIT ${LETTERS_KEPT}`
          const running =
            yield* sql`SELECT 1 FROM scheduled_tasks WHERE task_id = ${HOME_LETTER_AUTOMATION_ID} AND running_since IS NOT NULL`
          const now = DateTime.formatIso(yield* DateTime.now)
          const pending =
            yield* sql`SELECT 1 FROM automation_event_queue AS queue JOIN scheduled_tasks AS task ON task.task_id = queue.task_id
        WHERE queue.task_id = ${HOME_LETTER_AUTOMATION_ID} AND task.enabled = 1
          AND (queue.source IN ('scheduled', 'manual') OR queue.next_attempt_at IS NULL OR queue.next_attempt_at <= ${now})
        LIMIT 1`
          const queued = pending.length > 0 ? "pending" : "idle"
          const scheduled = yield* sql<{
            readonly next_run_at: string | null
          }>`SELECT next_run_at FROM scheduled_tasks WHERE task_id = ${HOME_LETTER_AUTOMATION_ID} AND enabled = 1`
          const generation = running.length > 0 ? "running" : queued
          const filed = yield* Effect.forEach(
            rows,
            Effect.fn(function* (row) {
              return {
                row,
                body: yield* decodeJson(
                  HomeLetterBodySchema,
                  withQuestionDestinations(row.body_json)
                ),
                sources: yield* decodeJson(
                  Schema.Array(HomeEvidenceSchema),
                  withQuestionDestinations(row.sources_json)
                )
              }
            })
          )
          const letters = filed.map(({ row, body, sources }) => ({
            run_id: row.run_id,
            generated_at: row.generated_at,
            window: { since: row.window_since, through: row.window_through },
            body,
            sources
          }))
          return yield* Schema.decodeUnknownEffect(HomeLetterResponseSchema)({
            window: current.window,
            headline: current.headline,
            letters,
            generation,
            next_at: scheduled[0]?.next_run_at ?? null
          })
        })
      ),
    homeAddressBook: (needs) => read(addressBook(needs)),
    checkHomeLetter: (input, rules) =>
      transaction(
        Effect.gen(function* () {
          const current = yield* snapshot(rules)
          if (current.entries.length === 0) return "skipped_no_input" as const
          if (current.fingerprint !== input.fingerprint) return "superseded" as const
          const cached = yield* state()
          return cached.source_fingerprint === input.fingerprint
            ? ("no_change" as const)
            : ("ready" as const)
        })
      ),
    publishHomeLetter: Effect.fn("WorkStore.publishHomeLetter")(function* (input) {
      const body = yield* Schema.decodeUnknownEffect(HomeLetterBodySchema)(input.body).pipe(
        Effect.mapError((cause) => workError("invalid", "Invalid Home letter body", cause))
      )
      if (
        body.paragraphs.flat().reduce((length, segment) => length + segment.text.length, 0) > 1_200
      ) {
        return yield* workError("invalid", "Home letter exceeds two short paragraphs")
      }
      const known = new Set([
        ...input.snapshot.entries.map((entry) => entry.id),
        ...input.rules.linkIds(input.snapshot.entries)
      ])
      const filed = {
        paragraphs: body.paragraphs.map((paragraph) =>
          paragraph.map((segment) =>
            segment.source_id === null || known.has(segment.source_id)
              ? segment
              : { ...segment, source_id: null }
          )
        )
      }
      const filedJson = JSON.stringify(filed)
      return yield* transaction(
        Effect.gen(function* () {
          const cached = yield* state()
          if (cached.run_id === input.runId) {
            if (cached.body_json !== filedJson)
              return yield* workError("conflict", "This Home Run already published another body")
            return true
          }
          const current = yield* collect(input.rules)
          if (!(yield* validSnapshot(input.snapshot, current, input.rules))) return false
          const runs = yield* sql<{
            readonly result: string | null
          }>`SELECT COALESCE(json_extract(run.metadata_json, '$.terminal_result.text'), message.search_text) AS result
          FROM chat_runs AS run LEFT JOIN session_messages AS message
            ON message.session_id = run.session_id AND message.message_id = run.assistant_message_id
          WHERE run.run_id = ${input.runId} AND run.status = 'completed'
          AND json_extract(run.metadata_json, '$.run_policy.execution.mode') = 'worker'
          AND json_extract(run.metadata_json, '$.run_context.origin.kind') = 'automation'
          AND json_extract(run.metadata_json, '$.run_context.origin.automation_id') = ${HOME_LETTER_AUTOMATION_ID}`
          if (!runs[0])
            return yield* workError(
              "invalid",
              "Home letter requires a completed Home Automation Worker Run"
            )
          const result = yield* decodeJson(HomeLetterBodySchema, runs[0].result).pipe(
            Effect.mapError((cause) =>
              workError("invalid", "Home Worker returned an invalid letter", cause)
            )
          )
          if (JSON.stringify(result) !== JSON.stringify(body))
            return yield* workError("invalid", "Home letter differs from its Worker result")
          const generatedAt = DateTime.formatIso(yield* DateTime.now)
          const sourcesJson = JSON.stringify(input.snapshot.entries)
          yield* sql`INSERT INTO home_letters (run_id, window_id, window_since, window_through, generated_at, body_json, sources_json)
          VALUES (${input.runId}, ${input.snapshot.window.id}, ${input.snapshot.window.since}, ${input.snapshot.through}, ${generatedAt}, ${filedJson}, ${sourcesJson})`
          yield* sql`DELETE FROM home_letters WHERE letter_id NOT IN (SELECT letter_id FROM home_letters ORDER BY generated_at DESC, letter_id DESC LIMIT ${LETTERS_KEPT})`
          yield* sql`UPDATE home_letter SET window_id = ${yield* nextId}, window_since = ${input.snapshot.through},
          source_fingerprint = ${input.snapshot.fingerprint}, run_id = ${input.runId}, generated_at = ${generatedAt},
          body_json = ${filedJson}, sources_json = ${sourcesJson}, snapshot_json = ${JSON.stringify(input.snapshot)}
          WHERE singleton_id = 1`
          return true
        })
      )
    })
  })
}
