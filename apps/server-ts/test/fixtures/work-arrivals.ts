import { SqliteClient } from "@effect/sql-sqlite-node"
import type { OperationalEvent } from "@arden-hq/protocol/daemon"
import { sha256Hex } from "@arden-hq/std/hash"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import type { ChatSendInput } from "../../src/chat/message-input.js"
import { ChatMessage } from "../../src/chat/message.js"
import type { ChatRunner } from "../../src/chat/runner-contract.js"
import type { ChatWriteStore } from "../../src/persistence/chat/store.js"
import type { RunDelivery } from "../../src/persistence/deliveries/model.js"
import { PersistenceWriteQueue } from "../../src/persistence/write-queue.js"
import { diagnosticsLayer } from "../../src/runtime/diagnostics.js"
import { ServerLifecycle } from "../../src/runtime/lifecycle.js"
import { recoveredSqlitePersistenceLayer } from "../../src/runtime/persistence-layer.js"
import { TerminalSessions } from "../../src/terminals/service.js"
import { toSendInput } from "../../src/work/arrivals-runtime.js"
import { noModelProvider } from "./no-model-provider.js"

const at = "2026-11-01T00:00:00.000Z"

export const withArrivalsDatabase = async (
  body: (filename: string) => Promise<void>
): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "arden-work-arrivals-"))
  try {
    await body(join(directory, "arden.db"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export const arrivalsLayer = (options: {
  readonly filename: string
  readonly runner: ChatRunner
  readonly events?: Array<OperationalEvent>
  readonly lifecycle?: Layer.Layer<never>
}) =>
  ChatMessage.layer({ runner: options.runner }).pipe(
    Layer.provide(noModelProvider),
    Layer.provide(TerminalSessions.layer),
    Layer.provide(options.lifecycle ?? Layer.empty),
    Layer.provideMerge(
      recoveredSqlitePersistenceLayer({ dataDir: null, filename: options.filename }).pipe(
        Layer.provide(PersistenceWriteQueue.layer),
        Layer.provide(
          diagnosticsLayer({
            startupPhase: () => {},
            migration: () => {},
            operational: (event) => options.events?.push(event)
          })
        )
      )
    ),
    Layer.provideMerge(SqliteClient.layer({ filename: options.filename }))
  )

export const openTurn: ChatRunner = async function* ({ signal }) {
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
  throw new Error("The test closed this turn")
}

export const stopsAfterOneAdmission = Layer.effect(
  ServerLifecycle,
  Effect.gen(function* () {
    const lifecycle = yield* ServerLifecycle
    let admissions = 1
    return { ...lifecycle, isAccepting: () => admissions-- > 0 }
  })
)

export const holdChat = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  chat: ChatWriteStore["Service"],
  sessionId: string
) {
  const run = yield* chat.start({
    sessionId,
    clientId: "earlier",
    requestHash: "earlier",
    assistantMessageId: "earlier-answer",
    message: {
      message_id: "earlier",
      client_id: "earlier",
      role: "user",
      content: "Earlier",
      created_at: at
    }
  })
  yield* sql`UPDATE chat_runs SET status = 'error', error_code = 'model_unavailable',
      ended_at = updated_at WHERE run_id = ${run.runId}`
})

export const deliveryIdOf = (name: string): string => sha256Hex(name)

export const insertOriginChat = (sql: SqlClient.SqlClient) => sql`INSERT INTO sessions (
    session_id, public_ref, name, started_at, last_activity, session_type
  ) VALUES ('origin', 'origin-ref', 'Origin', ${at}, ${at}, 'chat')`

export const insertPendingArrival = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly name: string
    readonly sessionId: string
    readonly parentId: string
    readonly kind?: "result" | "answer"
    readonly createdAt?: string
    readonly nextAttemptAt?: string
  }
) {
  const source = `${input.name}-worker`
  const runId = `${input.name}-run`
  const deliveryId = deliveryIdOf(input.name)
  yield* sql`INSERT INTO sessions (
    session_id, public_ref, name, started_at, last_activity,
    session_type, parent_session_id, parent_run_id, parent_tool_call_id
  ) VALUES (
    ${source}, ${`${source}-ref`}, ${source}, ${at}, ${at},
    'agent', ${input.parentId}, ${`${source}-parent-run`}, ${`${source}-spawn`}
  )`
  const budgetId = `${runId}-budget`
  yield* sql`INSERT INTO execution_budgets (budget_id) VALUES (${budgetId})`
  yield* sql`INSERT INTO chat_runs (
    run_id, session_id, status, started_at, updated_at, ended_at,
    metadata_json, assistant_message_id
  ) VALUES (
    ${runId}, ${source}, 'completed', ${at}, ${at}, ${at},
    ${JSON.stringify({ run_policy: { budget_id: budgetId } })}, ${`${runId}-answer`}
  )`
  yield* sql`INSERT INTO automation_deliveries (
    delivery_id, subject, body, payload, status, created_at, destinations, next_attempt_at
  ) VALUES (
    ${deliveryId}, 'Worker completed', ${`Result of ${input.name}`},
    ${JSON.stringify({
      kind: input.kind ?? "result",
      sessionId: input.sessionId,
      context: { origin: { kind: "chat", session_id: "origin", turn_id: "request" }, task: null },
      runIds: [runId],
      questionId: null
    })},
    'pending', ${input.createdAt ?? at}, '[]', ${input.nextAttemptAt ?? null}
  )`
  return deliveryId
})

export const resultSendInput = (delivery: RunDelivery): ChatSendInput => toSendInput(delivery)

export const readDelivery = (sql: SqlClient.SqlClient, deliveryId: string) =>
  sql<{
    readonly status: string
    readonly delivered_at: string | null
    readonly destinations: string
    readonly attempt_count: number
    readonly next_attempt_at: string | null
    readonly last_error: string | null
    readonly session_id: string | null
  }>`SELECT status, delivered_at, destinations, attempt_count, next_attempt_at, last_error,
      json_extract(payload, '$.sessionId') AS session_id
    FROM automation_deliveries WHERE delivery_id = ${deliveryId}`

const strandedAt = "2026-11-01T00:00:05.000Z"

export const strandDelivery = (sql: SqlClient.SqlClient, deliveryId: string) =>
  sql`UPDATE automation_deliveries SET status = 'pending', delivered_at = NULL,
      destinations = '[]', attempt_count = 3, next_attempt_at = ${strandedAt},
      last_error = 'Seeded pending beside its receipt'
    WHERE delivery_id = ${deliveryId}`

export const stranded = (sessionId: string) => ({
  status: "pending",
  delivered_at: null,
  destinations: "[]",
  attempt_count: 3,
  next_attempt_at: strandedAt,
  last_error: "Seeded pending beside its receipt",
  session_id: sessionId
})

export const admissionCounts = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  deliveryId: string
) {
  const clientId = `arrival:${deliveryId}`
  const receipts = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n
    FROM chat_idempotency_keys WHERE session_id = ${sessionId} AND client_id = ${clientId}`
  const messages = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n
    FROM session_messages WHERE session_id = ${sessionId} AND message_id = ${clientId}`
  const runs = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n
    FROM chat_runs WHERE session_id = ${sessionId}`
  return { receipts: receipts[0]?.n, messages: messages[0]?.n, runs: runs[0]?.n }
})
