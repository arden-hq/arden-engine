import { cutText, firstLine } from "@arden-hq/std/text"
import { captureMutationVersions } from "./mutation-links.js"
import { assertRunTaskAuthority } from "./run-task-authority.js"
import { readWorkState } from "./work-activity.js"
import type {
  CreateSpaceTaskInput,
  SpaceTask,
  SpaceTaskCaptureInput,
  SpaceTaskSource
} from "@arden-hq/protocol/spaces/work"
import {
  SpaceTaskCaptureInputSchema,
  decodeCreateSpaceTaskInputEffect
} from "@arden-hq/protocol/effect/spaces/work"
import { DateTime, Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql"
import { WorkStore, WorkStoreError, type CreateTaskInput, type TaskScope } from "../work/store.js"
import { makeSpaceJobSql } from "./space-jobs.js"
import type { SessionLifecycleEvents } from "../sessions/events.js"
import {
  decodeWorkItem as decodeWithSources,
  workItemColumns,
  type WorkItemRow
} from "./work-items.js"
import { taskScopeSql } from "./task-address.js"
import { ensureTaskBudget, isOrdinaryChat, requireInChatHome } from "./in-chat-task.js"
import { makeWorkSourceSql } from "./work-sources.js"
import type { Writer } from "./deps.js"
import type { UnitOfWork } from "../unit-of-work.js"
import { runMayActSql } from "./run-liveness.js"
import { slugify, uniqueName } from "@arden-hq/std/slug"

const taskKey = (text: string): string => slugify(text, { max: 60, fallback: "task" })

const workError = (reason: WorkStoreError["reason"], message: string, cause?: unknown) =>
  new WorkStoreError({ reason, message, ...(cause === undefined ? {} : { cause }) })

const freeItemId = Effect.fn("Work.freeItemId")(function* (
  sql: SqlClient.SqlClient,
  base: string
): Effect.fn.Return<string, WorkStoreError> {
  const taken = new Set(
    (yield* sql<{ readonly item_id: string }>`SELECT item_id FROM space_tasks
      WHERE item_id = ${base} OR item_id GLOB ${`${base}:*`}`.pipe(
      Effect.mapError((cause) => workError("storage", "Could not read the Task ids", cause))
    )).map((row) => row.item_id)
  )
  let candidate = base
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}:${n}`
  return candidate
})

const taskItemId = (scope: TaskScope, key: string): string => {
  switch (scope.kind) {
    case "space":
      return `work:${scope.spaceId}:${key}`
    case "chat":
      return `work:chat:${scope.sessionId}:${key}`
    case "none":
      return `work:none:${key}`
  }
}

const scopeWords = (scope: TaskScope): string => {
  switch (scope.kind) {
    case "space":
      return "on that Space"
    case "chat":
      return "in this chat"
    case "none":
      return "outside any Space"
  }
}

export const makeWorkCaptureSql = (options: {
  readonly writer: Writer
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly taskEvent: (
    spaceId: string | null,
    itemId: string,
    eventType: string,
    summary: string,
    at: string,
    runId?: string
  ) => Effect.Effect<void, WorkStoreError, UnitOfWork>
}) => {
  const { writer, sessionEvents, taskEvent } = options
  const sql = writer.sql
  const spaceJobs = makeSpaceJobSql(sql, sessionEvents)
  const sources = makeWorkSourceSql(sql)
  const decodeWorkItem = (row: WorkItemRow) =>
    sources
      .read([row.item_id])
      .pipe(
        Effect.flatMap((byItem) =>
          readWorkState(sql, [row.item_id]).pipe(
            Effect.flatMap((activity) =>
              decodeWithSources(row, byItem.get(row.item_id) ?? [], activity.get(row.item_id))
            )
          )
        )
      )

  const createInTransaction = Effect.fn("Work.captureInTransaction")(function* (options: {
    readonly scope: TaskScope
    readonly input: CreateSpaceTaskInput
    readonly actor: "user" | "worker"
    readonly taskSources: ReadonlyArray<SpaceTaskSource>
    readonly capture: SpaceTaskCaptureInput
    readonly runId?: string
    readonly toolCallId?: string
    readonly settledInference?: boolean
    readonly reuseExisting?: boolean
    readonly fromChat?: string
    readonly originMessageId?: string
  }) {
    const {
      scope,
      input,
      actor,
      taskSources,
      capture,
      runId,
      settledInference = false,
      reuseExisting = false,
      fromChat,
      originMessageId
    } = options
    const validInput = yield* decodeCreateSpaceTaskInputEffect(input).pipe(
      Effect.mapError((cause) => workError("invalid", "Invalid Space task input", cause))
    )
    const validCapture = yield* Schema.decodeUnknownEffect(SpaceTaskCaptureInputSchema)(capture, {
      onExcessProperty: "error"
    }).pipe(
      Effect.mapError((cause) =>
        workError("invalid", "Task capture requires a basis and reason", cause)
      )
    )
    if (validCapture.basis === "inferred") {
      if (scope.kind !== "space")
        return yield* workError("invalid", "An inferred Task belongs to a Space's inference flow.")
      if (!settledInference)
        return yield* workError(
          "invalid",
          "An inferred Task is proposed first; it exists once the person accepts the proposal."
        )
    }
    const now = DateTime.formatIso(yield* DateTime.now)
    const itemId = yield* freeItemId(sql, taskItemId(scope, validInput.key))
    const recordVersions = yield* captureMutationVersions(sql, {
      domain: "task",
      id: itemId,
      identity:
        runId !== undefined && options.toolCallId !== undefined
          ? { runId, toolCallId: options.toolCallId }
          : undefined
    })
    const originalBody =
      validInput.body === undefined || validInput.body === null
        ? validInput.text
        : `${validInput.text}\n\n${validInput.body}`

    return yield* Effect.gen(function* () {
      if (runId) yield* assertRunTaskAuthority(sql, runId)
      yield* requireScope(scope)
      const runsIn = validInput.runs_in ?? "background"
      const filedFrom =
        fromChat !== undefined && (yield* isOrdinaryChat(sql, fromChat)) ? fromChat : undefined
      const home = scope.kind === "chat" ? scope.sessionId : filedFrom
      if (runsIn === "chat") {
        if (home === undefined)
          return yield* workError("invalid", "A Task runs in a chat only when filed from it")
        yield* requireInChatHome(sql, { sessionId: home, itemId })
      }

      const undone = yield* sql`SELECT 1 FROM task_inference_rejections WHERE item_id = ${itemId}`
      if (undone.length > 0)
        return yield* workError(
          "conflict",
          "This inferred Task was undone. Use a new key for a newly requested Task; its prior history is retained."
        )
      const existing = (yield* sql<WorkItemRow>`
        SELECT ${workItemColumns(sql, "item")} FROM space_tasks AS item
        WHERE item.stable_key = ${validInput.key} AND ${taskScopeSql(sql, scope)}
        LIMIT 1`)[0]
      if (existing !== undefined) {
        if (validCapture.basis === "inferred" && reuseExisting)
          return yield* decodeWorkItem(existing)
        return yield* workError(
          "conflict",
          validCapture.basis === "inferred"
            ? "That Task already exists; inference cannot replace its original capture"
            : `A task with key '${validInput.key}' already exists ${scopeWords(scope)}`
        )
      }

      const rows = yield* sql<WorkItemRow>`
        INSERT INTO space_tasks (
          item_id, space_id, home_session_id, stable_key, text, body, status, owner,
          runs_in, token_budget, blocked, waiting_on, due_at, next_attempt_at, created_at,
          updated_at, completed_at, created_by, seq, block_count, capture,
          origin_message_id, original_body
        ) VALUES (
          ${itemId}, ${scope.kind === "space" ? scope.spaceId : null},
          ${home ?? null}, ${validInput.key}, ${validInput.text},
          ${validInput.body ?? null}, 'open', ${validInput.owner ?? "worker"},
          ${runsIn}, ${validInput.token_budget ?? null},
          0, NULL, NULL, NULL, ${now}, ${now}, NULL, ${actor},
          (SELECT COALESCE(MAX(item.seq), 0) + 1 FROM space_tasks AS item WHERE ${taskScopeSql(sql, scope)}),
          0, ${JSON.stringify(validCapture)},
          ${originMessageId ?? null}, ${originalBody}
        )
        RETURNING ${workItemColumns(sql)}
      `
      const row = rows[0]
      if (row === undefined) return yield* workError("storage", "Could not create Space task")

      yield* sources.add({ itemId: row.item_id, sources: taskSources, now })
      if (row.runs_in === "chat" || row.token_budget !== null)
        yield* ensureTaskBudget(sql, row.item_id, row.token_budget)
      yield* taskEvent(row.space_id, row.item_id, "created", row.text, now, runId)

      yield* spaceJobs.queueTaskWake(row.item_id, now)

      const [saved] =
        yield* sql<WorkItemRow>`SELECT ${workItemColumns(sql)} FROM space_tasks WHERE item_id = ${row.item_id}`
      if (saved === undefined) return yield* workError("storage", "Created Task disappeared")
      const task = yield* decodeWorkItem(saved)
      yield* recordVersions
      return task
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof WorkStoreError
          ? cause
          : workError("storage", "Could not complete Space task creation", cause)
      )
    )
  })

  const requireScope = Effect.fn("Work.requireScope")(function* (scope: TaskScope) {
    switch (scope.kind) {
      case "space": {
        const spaces = yield* sql`SELECT 1 FROM spaces
          WHERE space_id = ${scope.spaceId} AND archived_at IS NULL`.pipe(
          Effect.mapError((cause) => workError("storage", "Could not validate the Space", cause))
        )
        if (spaces.length === 0) return yield* workError("not_found", "Space not found")
        return
      }
      case "chat": {
        const chats = yield* sql<{ readonly space_id: string | null }>`SELECT space_id FROM sessions
          WHERE session_id = ${scope.sessionId} AND session_type = 'chat' AND archived_at IS NULL`.pipe(
          Effect.mapError((cause) => workError("storage", "Could not validate the chat", cause))
        )
        const chat = chats[0]
        if (chat === undefined) return yield* workError("not_found", "Chat not found")
        if (chat.space_id !== null)
          return yield* workError(
            "invalid",
            "This chat is in a Space; its Tasks belong to that Space"
          )
        return
      }
      case "none":
        return
    }
  })

  const createFor = Effect.fn("SqliteWorkStore.createFor")(function* (
    scope: TaskScope,
    input: CreateTaskInput,
    actor: "user" | "worker",
    taskSources: ReadonlyArray<SpaceTaskSource>,
    capture: SpaceTaskCaptureInput,
    runId?: string,
    fromChat?: string,
    originMessageId?: string,
    toolCallId?: string
  ): Effect.fn.Return<SpaceTask, WorkStoreError> {
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const key = input.key ?? (yield* freeKey(scope, input.text))
          return yield* createInTransaction({
            scope,
            input: { ...input, key },
            actor,
            taskSources,
            capture,
            ...(toolCallId === undefined ? {} : { toolCallId }),
            ...(runId === undefined ? {} : { runId }),
            ...(fromChat === undefined ? {} : { fromChat }),
            ...(originMessageId === undefined ? {} : { originMessageId })
          })
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof WorkStoreError
            ? cause
            : workError("storage", "Could not complete Space task creation", cause)
        )
      )
  })

  const create: WorkStore["Service"]["create"] = (scope, input) =>
    createFor(scope, input, "user", [], { basis: "explicit", reason: "Created by you." })

  const createFromChat: WorkStore["Service"]["createFromChat"] = Effect.fn("Work.createFromChat")(
    function* (options) {
      if (options.capture.basis === "inferred") {
        return yield* workError(
          "invalid",
          "Chat creates Tasks only for explicit tracking or long-horizon requests. Inferred capture belongs to the Space inference flow."
        )
      }
      const rows = yield* sql<{ readonly turn_id: unknown }>`
        SELECT json_extract(run.metadata_json, '$.turn_id') AS turn_id FROM chat_runs AS run
        WHERE run.run_id = ${options.runId} AND run.session_id = ${options.sessionId}
          AND ${runMayActSql(sql, "run")}
      `.pipe(
        Effect.mapError((cause) =>
          workError("storage", "Could not resolve the originating Chat turn", cause)
        )
      )
      const turnId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(
        rows[0]?.turn_id
      ).pipe(
        Effect.mapError((cause) =>
          workError(
            "invalid",
            "Task capture requires a Chat run that may still act, with a recorded turn",
            cause
          )
        )
      )
      const origin = yield* sql<{ readonly message_id: string }>`
        SELECT message_id FROM session_messages
        WHERE session_id = ${options.sessionId} AND message_id = ${turnId} AND role = 'user'
      `.pipe(
        Effect.mapError((cause) =>
          workError("storage", "Could not read the originating user message", cause)
        )
      )
      return yield* createFor(
        options.scope,
        options.input,
        "worker",
        [
          {
            kind: "chat",
            session_id: options.sessionId,
            turn_id: turnId,
            revision: turnId
          }
        ],
        options.capture,
        options.runId,
        options.sessionId,
        origin[0]?.message_id,
        options.toolCallId
      )
    }
  )

  const freeKey = Effect.fn("Work.freeKey")(function* (scope: TaskScope, text: string) {
    const base = taskKey(text)
    const taken = new Set(
      (yield* sql<{ readonly stable_key: string }>`
        SELECT item.stable_key FROM space_tasks AS item
        WHERE (item.stable_key = ${base} OR item.stable_key LIKE ${`${base}-%`})
          AND ${taskScopeSql(sql, scope)}`.pipe(
        Effect.mapError((cause) => workError("storage", "Could not read the Task keys", cause))
      )).map((row) => row.stable_key)
    )
    return uniqueName(base, taken)
  })

  const createInChat: WorkStore["Service"]["createInChat"] = Effect.fn("Work.createInChat")(
    function* (sessionId, input) {
      const chats = yield* sql<{
        readonly space_id: string | null
        readonly space_conversation: number
      }>`
        SELECT space_id, EXISTS (SELECT 1 FROM space_conversations AS conversation
          WHERE conversation.session_id = sessions.session_id) AS space_conversation
        FROM sessions WHERE session_id = ${sessionId} AND archived_at IS NULL`.pipe(
        Effect.mapError((cause) => workError("storage", "Could not read the chat", cause))
      )
      const chat = chats[0]
      if (chat === undefined) return yield* workError("not_found", "Chat not found")
      const scope: TaskScope =
        chat.space_id === null
          ? { kind: "chat", sessionId }
          : { kind: "space", spaceId: chat.space_id }
      const request = input.request.trim()
      const first = firstLine(request)
      if (first.length === 0) return yield* workError("invalid", "Say what to keep working on")
      const text = cutText(first, 80)
      return yield* createFor(
        scope,
        {
          text,
          body: request === text ? null : request,
          owner: "worker",
          runs_in: chat.space_conversation === 1 ? "background" : "chat",
          ...(input.token_budget === undefined ? {} : { token_budget: input.token_budget })
        },
        "user",
        [],
        { basis: "explicit", reason: "You asked this chat to keep working on it." },
        undefined,
        sessionId
      )
    }
  )

  return {
    create,
    createFromChat,
    createInChat,
    createInTransaction
  }
}
