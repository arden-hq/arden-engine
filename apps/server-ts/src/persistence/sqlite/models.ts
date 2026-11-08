import type { ModelContextBudget } from "../models/store.js"
import type {
  ModelAssignment,
  ModelResetScope,
  ModelRole,
  ModelSettingsPatch
} from "@arden-hq/protocol/models"
import { ModelSettingsPatchSchema } from "@arden-hq/protocol/effect/models"
import { Effect, Result, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ModelCatalogError, type ModelCatalog } from "../../models/catalog.js"
import { ModelStore, ModelStoreError, type ModelStoreOperation } from "../models/store.js"
import type { IntelligenceSettingsStore } from "../settings/store.js"
import {
  applyPatch,
  emptySnapshot,
  selectModel,
  selectRole,
  migrateLegacyRoles,
  resetScope,
  SettingsJson,
  snapshot as toSnapshot,
  validTarget,
  type ModelSettingsRuntime,
  type PersistedModelSettings,
  type SettingsFault
} from "../models/settings.js"
import type { PersistenceDeps } from "./deps.js"

const Id = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const BudgetInput = Schema.Struct({
  modelId: Schema.NullOr(Id),
  inputTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  messageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
interface SettingsRow {
  readonly settings_json: string | null
}
interface SessionRow {
  readonly chat_model: string | null
}

const error = (
  operation: ModelStoreOperation,
  reason: ModelStoreError["reason"],
  message: string,
  sessionId?: string,
  cause?: unknown
) =>
  new ModelStoreError({
    operation,
    reason,
    message,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(cause === undefined ? {} : { cause })
  })
const storage =
  (operation: ModelStoreOperation, message: string, sessionId?: string) => (cause: unknown) =>
    error(operation, "storage", message, sessionId, cause)
const preserve =
  (operation: ModelStoreOperation, message: string, sessionId?: string) => (cause: unknown) =>
    cause instanceof ModelStoreError ? cause : storage(operation, message, sessionId)(cause)
const lift = <A>(
  result: Result.Result<A, SettingsFault>,
  operation: ModelStoreOperation,
  sessionId?: string
) =>
  Effect.fromResult(result).pipe(
    Effect.mapError((fault) => error(operation, fault.reason, fault.message, sessionId))
  )

const decode = (value: string, operation: ModelStoreOperation) =>
  Schema.decodeUnknownEffect(SettingsJson)(migrateLegacyRoles(value), {
    onExcessProperty: "error"
  }).pipe(Effect.mapError(storage(operation, "Stored model settings are corrupt")))
const encode = (value: PersistedModelSettings, operation: ModelStoreOperation) =>
  Schema.encodeEffect(SettingsJson)(value).pipe(
    Effect.mapError((cause) =>
      error(operation, "invalid", "Model settings cannot be encoded", undefined, cause)
    )
  )

const loadSettings = Effect.fn("SqliteModelStore.loadSettings")(function* (
  sql: SqlClient.SqlClient,
  operation: ModelStoreOperation
) {
  const rows =
    yield* sql<SettingsRow>`SELECT settings_json FROM model_settings WHERE singleton_id = 1`.pipe(
      Effect.mapError(storage(operation, "Could not read model settings"))
    )
  const value = rows[0]?.settings_json
  if (value === undefined)
    return yield* error(operation, "storage", "Model settings singleton is missing")
  if (value === null)
    return yield* error(operation, "storage", "Model settings are not initialized")
  return yield* decode(value, operation)
})

const loadSessionModel = Effect.fn("SqliteModelStore.loadSessionModel")(function* (
  sql: SqlClient.SqlClient,
  sessionId: string,
  operation: "selection" | "set_session_model"
) {
  const rows =
    yield* sql<SessionRow>`SELECT chat_model FROM sessions WHERE session_id = ${sessionId}`.pipe(
      Effect.mapError(storage(operation, "Could not resolve the Session model", sessionId))
    )
  if (rows[0] === undefined)
    return yield* error(operation, "not_found", "Session not found", sessionId)
  return rows[0].chat_model
})

const seedDefaults = Effect.fn("SqliteModelStore.seedDefaults")(function* ({
  writer,
  runtime
}: Pick<PersistenceDeps, "writer"> & {
  readonly runtime: ModelSettingsRuntime
}) {
  const sql = writer.sql
  if (!runtime.available) return
  const json = yield* encode(runtime.defaults, "settings")
  yield* writer
    .transact(
      sql`
    UPDATE model_settings SET settings_json = ${json}
    WHERE singleton_id = 1 AND settings_json IS NULL
  `.pipe(Effect.mapError(storage("settings", "Could not initialize model settings")), Effect.asVoid)
    )
    .pipe(Effect.mapError(preserve("settings", "Could not initialize model settings")))
})

export const makeModelDefaultsSeed = ({ writer }: Pick<PersistenceDeps, "writer">) => {
  let seeded = false
  return Effect.fn("SqliteModelStore.seed")(function* (runtime: ModelSettingsRuntime) {
    if (seeded) return
    yield* seedDefaults({ writer, runtime }).pipe(
      Effect.mapError(
        (cause) => new ModelCatalogError({ reason: "storage", message: cause.message, cause })
      )
    )
    seeded = runtime.available
  })
}

const readModelSnapshot = Effect.fn("SqliteModelStore.readSnapshot")(function* (
  sql: SqlClient.SqlClient,
  runtime: ModelSettingsRuntime
) {
  if (!runtime.available) return emptySnapshot()
  return toSnapshot(yield* loadSettings(sql, "settings"), runtime.defaults)
})

export type ModelRequest = { readonly modelId: string } | { readonly modelRole: ModelRole }

export const readRequestedModel = Effect.fn("SqliteModelStore.readRequestedModel")(function* (
  sql: SqlClient.SqlClient,
  runtime: ModelSettingsRuntime,
  request: ModelRequest
) {
  if (!runtime.available) {
    if ("modelId" in request)
      return yield* error("selection", "unavailable", `Model ${request.modelId} is not available`)
    return { modelId: null, reasoningEffort: null }
  }
  const stored = yield* loadSettings(sql, "selection")
  return yield* lift(
    "modelId" in request
      ? selectModel(stored, request.modelId, runtime)
      : selectRole(stored, request.modelRole, runtime),
    "selection"
  )
})

export const runInheritsChatModel = (
  contextMode: "fresh" | "continue" | "fork" | undefined,
  chatModel: string | null
): boolean => contextMode !== undefined && contextMode !== "fresh" && chatModel !== null

export const readModelSelection = Effect.fn("SqliteModelStore.readSelection")(function* (
  sql: SqlClient.SqlClient,
  runtime: ModelSettingsRuntime,
  sessionId: string
): Effect.fn.Return<ModelAssignment, ModelStoreError> {
  const override = yield* loadSessionModel(sql, sessionId, "selection")
  if (!runtime.available) return { modelId: null, reasoningEffort: null }
  return yield* lift(
    selectModel(yield* loadSettings(sql, "selection"), override, runtime),
    "selection",
    sessionId
  )
})

export const makeModelStore = ({
  writer,
  catalog,
  intelligence
}: Pick<PersistenceDeps, "writer"> & {
  readonly catalog: ModelCatalog["Service"]
  readonly intelligence: IntelligenceSettingsStore["Service"]
}): ModelStore["Service"] => {
  const sql = writer.sql
  const currentRuntime = () =>
    catalog
      .runtime()
      .pipe(
        Effect.mapError((cause) => error("catalog", cause.reason, cause.message, undefined, cause))
      )
  const snapshot = Effect.fn("SqliteModelStore.snapshot")(function* () {
    return yield* readModelSnapshot(sql, yield* currentRuntime())
  })
  const reset = Effect.fn("SqliteModelStore.reset")(function* (scope: ModelResetScope) {
    const runtime = yield* currentRuntime()
    if (!runtime.available)
      return yield* error("reset", "unavailable", "No model catalog is configured")
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const next = resetScope(yield* loadSettings(sql, "reset"), runtime.defaults, scope)
          const json = yield* encode(next, "reset")
          const rows = yield* sql<SettingsRow>`
        UPDATE model_settings SET settings_json = ${json}
        WHERE singleton_id = 1 RETURNING settings_json
      `.pipe(Effect.mapError(storage("reset", "Could not reset model settings")))
          if (rows.length === 0)
            return yield* error("reset", "storage", "Model settings singleton is missing")
          return toSnapshot(next, next)
        })
      )
      .pipe(Effect.mapError(preserve("reset", "Could not complete the model settings reset")))
  })
  const patch = Effect.fn("SqliteModelStore.patch")(function* (input: ModelSettingsPatch) {
    const runtime = yield* currentRuntime()
    const valid = yield* Schema.decodeUnknownEffect(ModelSettingsPatchSchema)(input, {
      onExcessProperty: "error"
    }).pipe(
      Effect.mapError((cause) =>
        error("patch", "invalid", "Invalid model settings patch", undefined, cause)
      )
    )
    if (!runtime.available)
      return yield* error("patch", "unavailable", "No model catalog is configured")
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const next = yield* lift(
            applyPatch(yield* loadSettings(sql, "patch"), valid, runtime),
            "patch"
          )
          const json = yield* encode(next, "patch")
          const rows = yield* sql<SettingsRow>`
        UPDATE model_settings SET settings_json = ${json}
        WHERE singleton_id = 1 RETURNING settings_json
      `.pipe(Effect.mapError(storage("patch", "Could not update model settings")))
          if (rows.length === 0)
            return yield* error("patch", "storage", "Model settings singleton is missing")
          return toSnapshot(next, runtime.defaults)
        })
      )
      .pipe(Effect.mapError(preserve("patch", "Could not complete model settings update")))
  })
  const selection = Effect.fn("SqliteModelStore.selection")(function* (
    value: string
  ): Effect.fn.Return<ModelAssignment, ModelStoreError> {
    const sessionId = yield* Schema.decodeUnknownEffect(Id)(value).pipe(
      Effect.mapError((cause) =>
        error("selection", "invalid", "Session id must not be empty", undefined, cause)
      )
    )
    return yield* readModelSelection(sql, yield* currentRuntime(), sessionId)
  })
  const setSessionModel = Effect.fn("SqliteModelStore.setSessionModel")(function* (
    value: string,
    inputModelId: string | null
  ) {
    const sessionId = yield* Schema.decodeUnknownEffect(Id)(value).pipe(
      Effect.mapError((cause) =>
        error("set_session_model", "invalid", "Session id must not be empty", undefined, cause)
      )
    )
    const modelId = yield* Schema.decodeUnknownEffect(Schema.NullOr(Id))(inputModelId).pipe(
      Effect.mapError((cause) =>
        error("set_session_model", "invalid", "Invalid Session model", sessionId, cause)
      )
    )
    const runtime = yield* currentRuntime()
    if (!runtime.available) {
      return yield* error(
        "set_session_model",
        "unavailable",
        "No model catalog is configured",
        sessionId
      )
    }
    yield* lift(validTarget(runtime, modelId), "set_session_model", sessionId)
    return yield* writer
      .transact(
        Effect.gen(function* () {
          const selected = yield* lift(
            selectModel(yield* loadSettings(sql, "set_session_model"), modelId, runtime),
            "set_session_model",
            sessionId
          )
          if (selected.modelId === null) {
            return yield* error(
              "set_session_model",
              "unavailable",
              "No Chat model is configured",
              sessionId
            )
          }
          const rows = yield* sql<{ readonly session_id: string }>`
        UPDATE sessions SET chat_model = ${modelId}
        WHERE session_id = ${sessionId} RETURNING session_id
      `.pipe(
            Effect.mapError(
              storage("set_session_model", "Could not update the Session model", sessionId)
            )
          )
          if (rows.length === 0)
            return yield* error("set_session_model", "not_found", "Session not found", sessionId)
          return { sessionId, overrideModelId: modelId, ...selected }
        })
      )
      .pipe(
        Effect.mapError(
          preserve("set_session_model", "Could not complete the Session model update", sessionId)
        )
      )
  })
  const contextBudget = Effect.fn("SqliteModelStore.contextBudget")(function* (input: {
    readonly modelId: string | null
    readonly inputTokens: number
    readonly messageCount: number
  }): Effect.fn.Return<ModelContextBudget, ModelStoreError> {
    const valid = yield* Schema.decodeUnknownEffect(BudgetInput)(input, {
      onExcessProperty: "error"
    }).pipe(
      Effect.mapError((cause) =>
        error("context_budget", "invalid", "Invalid context budget input", undefined, cause)
      )
    )
    const runtime = catalog.installed()
    if (!runtime.available)
      return yield* error("context_budget", "unavailable", "No model catalog is configured")
    const stored = valid.modelId === null ? yield* loadSettings(sql, "context_budget") : null
    const modelId = valid.modelId ?? stored?.chatModelId
    if (modelId === null || modelId === undefined) {
      return yield* error("context_budget", "unavailable", "No Chat model is configured")
    }
    const selected = runtime.models.get(modelId)
    if (selected === undefined)
      return yield* error("context_budget", "unavailable", `Model ${modelId} is not available`)
    const controls = yield* intelligence
      .settings()
      .pipe(
        Effect.mapError((cause) =>
          error(
            "context_budget",
            "storage",
            "Could not read intelligence settings",
            undefined,
            cause
          )
        )
      )
    return {
      model: selected.id,
      hard_limit: selected.context.hardLimit,
      compaction_trigger: Math.floor(selected.context.hardLimit * controls.compactionThreshold),
      input_tokens: valid.inputTokens,
      message_count: valid.messageCount
    }
  })
  const roleSelection = Effect.fn("SqliteModelStore.roleSelection")(function* (role: ModelRole) {
    return yield* readRequestedModel(sql, yield* currentRuntime(), { modelRole: role })
  })
  return ModelStore.of({
    snapshot,
    patch,
    reset,
    setSessionModel,
    selection,
    roleSelection,
    contextBudget
  })
}
