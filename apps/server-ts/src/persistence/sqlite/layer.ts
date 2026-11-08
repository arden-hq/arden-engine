import { HomeStore } from "../home/store.js"
import { makeHomeStore } from "./home-letter.js"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Reactivity } from "effect/unstable/reactivity"
import { makeJournalRuntime } from "@arden-hq/journal/effect"
import { ChatEventStore } from "../events/store.js"
import { SpaceStore } from "../spaces/store.js"
import { WorkStore } from "../work/store.js"
import { TaskProposalStore } from "../proposals/store.js"
import { FocusChoiceStore } from "../focus-choices/store.js"
import { CommunicationStore } from "../continuity/store.js"
import { ChatWriteStore } from "../chat/store.js"
import { TodoStore } from "../todos/store.js"
import { AnswerBlockStore } from "../answer-blocks/store.js"
import { SummaryStore } from "../summaries/store.js"
import { InboxStore } from "../inbox/store.js"
import { ToolExecutionStore } from "../tools/store.js"
import { ToolHistoryQueries } from "../tools/history-queries.js"
import { SessionQueries } from "../sessions/queries.js"
import { SessionStore } from "../sessions/store.js"
import { SessionLifecycleEvents } from "../sessions/events.js"
import { makeSessionLifecycleEvents } from "./lifecycle-events.js"
import { SessionReadState } from "../sessions/read-state.js"
import { TranscriptQueries } from "../transcript/queries.js"
import { SessionTurnQueries } from "../turns/queries.js"
import { RunQueries } from "../runs/queries.js"
import { databaseSchema } from "../schema/database.js"
import { LATEST_SCHEMA_VERSION } from "../migrations/index.js"
import {
  buildReferenceSchemaManifest,
  classifySchemaManifest,
  schemaIdentity,
  type SchemaManifestRow
} from "../schema/manifest.js"
import { makeChatEventStore } from "./events.js"
import { makeSpaceStore } from "./spaces.js"
import { makeWorkStore } from "./work.js"
import { makeTaskProposalStore } from "./task-proposals.js"
import { withTaskProposalReview } from "./task-proposal-review.js"
import { makeConnectionItemStore } from "./connection-items.js"
import { makeCapabilityOfferStore } from "./capability-offers.js"
import { CapabilityOfferStore } from "../capability-offers/store.js"
import { ConnectionItemStore } from "../connections/store.js"
import { makeFocusChoiceStore } from "./focus-choices.js"
import { makeCommunicationStore } from "./continuity.js"
import { makeRunQueries } from "./runs.js"
import { makeSessionQueries } from "./session-queries.js"
import { makeSessionStore } from "./sessions.js"
import { makeSessionReadState } from "./read-state.js"
import { makeTranscriptQueries } from "./transcript.js"
import { makeSessionTurnQueries } from "./turn-queries.js"
import { makeChatWriteStore } from "./chat.js"
import { makeTodoStore } from "./todos.js"
import { makeAnswerBlockStore } from "./answer-blocks.js"
import { makeSummaryStore } from "./summaries.js"
import { makeInboxStore } from "./inbox.js"
import { makeToolStores } from "./tools.js"
import { ApprovalPolicyStore } from "../permissions/approval-policy.js"
import { makeApprovalPolicyStore } from "./approval-policy.js"
import { DeferredToolCalls } from "../tools/deferred.js"
import { makeDeferredToolCalls } from "./deferred-tool-calls.js"
import { PermissionRules } from "../permissions/rules.js"
import { makePermissionRules } from "./permission-rules.js"
import { PersistenceWriteQueue } from "../write-queue.js"
import { BackfillStore } from "../backfills/store.js"
import { makeBackfillRuntime } from "./backfills/runtime.js"
import { interruptActiveChatRunsAfterRestart } from "./recovery.js"
import { ModelStore } from "../models/store.js"
import { makeModelDefaultsSeed, makeModelStore } from "./models.js"
import { ModelCatalog, makeModelCatalog } from "../../models/catalog.js"
import { ChatRules } from "../chat/rules.js"
import { ContextCompactionStore } from "../compaction/store.js"
import { makeContextCompactionStore } from "./compaction.js"
import type { ModelHost, ModelHostSource } from "../../models/host.js"
import { WikiRenameStore } from "../wiki/rename-store.js"
import { makeWikiRenameStore } from "./wiki-renames.js"
import { WikiMaintenanceStore } from "../wiki-maintenance/store.js"
import { makeWikiMaintenanceStore } from "./wiki-maintenance.js"
import { AutomationCatalog } from "../automations/catalog.js"
import { AutomationRules } from "../automations/model.js"
import { WikiEventOutbox } from "../automations/wiki-event-outbox.js"
import { HomeLetterInputs } from "../automations/home-letter-inputs.js"
import { SpaceReviewStore } from "../automations/space-review-store.js"
import { AutomationHandlerItems } from "../automations/handler-items.js"
import { AutomationTriggers } from "../automations/triggers.js"
import { AutomationQueue } from "../automations/queue.js"
import { makeAutomationStores } from "./automations.js"
import { MemoryCaptureStore } from "../memory/store.js"
import { WikiEmbeddingStore } from "../memory/embedding-store.js"
import { makeMemoryCaptureStore } from "./memory.js"
import { makeWikiEmbeddingStore } from "./wiki-embeddings.js"
import { McpStore } from "../mcp/store.js"
import { makeMcpStore } from "./mcp.js"
import { PermissionStore } from "../permissions/store.js"
import { makePermissionStore } from "./permissions.js"
import { AuthorityHistoryStore } from "../permissions/history.js"
import { makeAuthorityHistoryStore } from "./authority-history.js"
import { StoragePolicyStore } from "../storage/store.js"
import { makeStoragePolicyStore } from "./storage.js"
import { StorageSessionStore } from "../storage/session-store.js"
import { makeStorageSessionStore } from "./storage-sessions.js"
import { compactExpiredAgentSessions } from "./agent-retention.js"
import { trimJournals } from "./journal-retention.js"
import {
  EmbeddingSettingsStore,
  IntelligenceSettingsStore,
  LimitSettingsStore
} from "../settings/store.js"
import { makeIntelligenceSettingsStore } from "./intelligence-settings.js"
import { makeEmbeddingSettingsStore } from "./embedding-settings.js"
import { ModelEndpointStore } from "../model-endpoints/store.js"
import { makeModelEndpointStore } from "./model-endpoints.js"
import { makeLimitSettingsStore } from "./limit-settings.js"
import { UsageStore } from "../usage/store.js"
import { BrowserProcedureStore } from "../browser-procedures/store.js"
import { makeBrowserProcedureStore } from "./browser-procedures.js"
import { DriveUploadStore } from "../drive-uploads/store.js"
import { makeDriveUploadStore } from "./drive-uploads.js"
import { makeUsageStore } from "./usage.js"
import { RelayStore } from "../relay/store.js"
import { makeRelayStore } from "./relay.js"
import { ScriptStore } from "../scripts/store.js"
import { makeScriptStore } from "./script-store.js"
import { ScriptResults } from "../scripts/results.js"
import { ScriptJournal } from "../scripts/journal.js"
import { makeScriptJournal } from "./script-journal.js"
import { makeScriptResults } from "./script-results.js"
import { Persistence, StorageStartupError } from "../service.js"
import { makeWriter, type PersistenceDeps } from "./deps.js"
import { installCapture } from "./tells/capture.js"
import { makeTellAtCommit } from "./tells/tell.js"
import type { UnitOfWork } from "../unit-of-work.js"
import { initializeSearchIndex } from "./search.js"
import { sqliteWriterLayer } from "./writer-client.js"
import { makeSqliteThreadClient } from "@arden-hq/sqlite-thread"
import { ManagedOutputLifecycleStore } from "../managed-output/lifecycle-store.js"
import { makeManagedOutputLifecycleStore } from "./managed-output-lifecycle.js"
import { Diagnostics } from "../../runtime/diagnostics.js"
import { migrateAtStartup, recordDataVersion, type ReleaseStorage } from "./release-safety.js"

export interface SqlitePersistenceOptions {
  readonly filename: string
  readonly models?: ModelHostSource | undefined
  readonly refreshModelHost?: (() => Promise<ModelHost>) | undefined
  readonly record?: { readonly storage: ReleaseStorage; readonly version: string } | undefined
  readonly dataDir: string | null
}

const initError = (message: string, cause?: unknown): StorageStartupError =>
  new StorageStartupError({
    operation: "initialize",
    message,
    ...(cause === undefined ? {} : { cause })
  })

const probePragma = Effect.fn("SqlitePersistence.probePragma")(function* (
  sql: SqlClient.SqlClient,
  pragma: "auto_vacuum" | "synchronous"
) {
  const rows = yield* sql
    .unsafe<Record<string, unknown>>(`PRAGMA ${pragma}`)
    .pipe(Effect.mapError((cause) => initError(`Could not inspect SQLite ${pragma}`, cause)))
  const value = rows[0]?.[pragma]
  if (typeof value !== "number") {
    return yield* initError(`SQLite did not report ${pragma}`)
  }
  return value
})

const verifyJournalMode = Effect.fn("SqlitePersistence.verifyJournalMode")(function* (
  sql: SqlClient.SqlClient
) {
  const rows = yield* sql
    .unsafe<{ readonly journal_mode: unknown }>("PRAGMA journal_mode")
    .pipe(Effect.mapError((cause) => initError("Could not inspect SQLite journal mode", cause)))
  const journalMode = rows[0]?.journal_mode
  if (journalMode === "wal") return
  if (journalMode === "memory") {
    const databases = yield* sql
      .unsafe<{
        readonly name: unknown
        readonly file: unknown
      }>("PRAGMA database_list")
      .pipe(Effect.mapError((cause) => initError("Could not inspect SQLite database files", cause)))
    if (databases.some((database) => database.name === "main" && database.file === "")) return
  }
  return yield* initError(
    `SQLite journal mode is ${String(journalMode)}; file-backed current storage requires WAL`
  )
})

const configureConnection = Effect.fn("SqlitePersistence.configureConnection")(function* (
  sql: SqlClient.SqlClient
) {
  yield* verifyJournalMode(sql)
  yield* sql
    .unsafe("PRAGMA synchronous = NORMAL")
    .pipe(
      Effect.mapError((cause) => initError("Could not configure SQLite synchronous mode", cause))
    )
  const synchronous = yield* probePragma(sql, "synchronous")
  if (synchronous !== 1) {
    return yield* initError(
      `SQLite synchronous mode is ${synchronous}; the current storage baseline requires NORMAL (1)`
    )
  }
})

const prepareFreshStorage = Effect.fn("SqlitePersistence.prepareFreshStorage")(function* (
  sql: SqlClient.SqlClient
) {
  yield* sql
    .unsafe("PRAGMA auto_vacuum = INCREMENTAL")
    .pipe(
      Effect.mapError((cause) =>
        initError("Could not configure SQLite incremental auto-vacuum", cause)
      )
    )
  let autoVacuum = yield* probePragma(sql, "auto_vacuum")
  if (autoVacuum !== 2) {
    yield* sql
      .unsafe("VACUUM")
      .pipe(
        Effect.mapError((cause) =>
          initError("Could not initialize SQLite incremental auto-vacuum", cause)
        )
      )
    autoVacuum = yield* probePragma(sql, "auto_vacuum")
  }
  if (autoVacuum !== 2) {
    return yield* initError(
      `SQLite auto_vacuum mode is ${autoVacuum}; the current storage baseline requires INCREMENTAL (2)`
    )
  }
})

const readLiveSchemaManifest = (sql: SqlClient.SqlClient) =>
  sql<SchemaManifestRow>`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT GLOB 'sqlite_*'
    ORDER BY type, name
  `.pipe(
    Effect.mapError((cause) => initError("Could not inspect the SQLite schema manifest", cause))
  )

const probeSchemaManifest = Effect.fn("SqlitePersistence.probeSchemaManifest")(function* (
  sql: SqlClient.SqlClient
) {
  const diagnostics = yield* Diagnostics
  const referenceRows = yield* Effect.try({
    try: buildReferenceSchemaManifest,
    catch: (cause) => initError("Could not build the current SQLite schema manifest", cause)
  })
  const liveRows = yield* readLiveSchemaManifest(sql)
  const reference = new Set(referenceRows.map(schemaIdentity))
  const foreignTables = liveRows.filter(
    (row) => row.type === "table" && !reference.has(schemaIdentity(row))
  )
  const foreignReferences = new Map(
    yield* Effect.forEach(foreignTables, (row) =>
      sql<{ readonly target: string }>`
      SELECT "table" AS target FROM pragma_foreign_key_list(${row.name}) ORDER BY id, seq
    `.pipe(
        Effect.map((references) => [row.name, references.map((item) => item.target)] as const),
        Effect.mapError((cause) =>
          initError(`Could not inspect foreign table dependencies for ${row.name}`, cause)
        )
      )
    )
  )
  const verdict = classifySchemaManifest(referenceRows, liveRows, foreignReferences)
  if (verdict.foreign.length > 0) {
    yield* Effect.logWarning("Foreign SQLite schema objects are present", {
      verdict: "foreign_warning",
      objects: verdict.foreign.map((row) => `${row.type}:${row.name}`).join(", ")
    })
    yield* Effect.forEach(
      verdict.foreign,
      (row) =>
        diagnostics.operational({
          code: "storage.schema_drift",
          severity: "warning",
          cause: null,
          objectType: row.type,
          objectName: row.name,
          verdict: "foreign_warning"
        }),
      { discard: true }
    )
  }
  if (verdict.kind === "incompatible") {
    yield* Effect.forEach(
      verdict.problems,
      (problem) => {
        const identity = problem.split(" ")[0] ?? "manifest:unknown"
        const separator = identity.indexOf(":")
        return diagnostics.operational({
          code: "storage.schema_drift",
          severity: "error",
          cause: problem,
          objectType: separator < 0 ? "manifest" : identity.slice(0, separator),
          objectName: separator < 0 ? identity : identity.slice(separator + 1),
          verdict: "owned_fatal"
        })
      },
      { discard: true }
    )
    return yield* initError(
      `SQLite schema manifest is incompatible; ${verdict.problems.join("; ")}`
    )
  }
  if (verdict.kind === "conversion_required") {
    return yield* initError(
      `SQLite schema is missing: ${verdict.missing
        .map((row) => `${row.type}:${row.name}`)
        .join(", ")}`
    )
  }
})

const probeSchemaVersion = Effect.fn("SqlitePersistence.probeSchemaVersion")(function* (
  sql: SqlClient.SqlClient
) {
  const rows = yield* sql<{ readonly user_version: number }>`PRAGMA user_version`.pipe(
    Effect.mapError((cause) => initError("Could not read the SQLite schema version", cause))
  )
  const version = rows[0]?.user_version
  if (version !== LATEST_SCHEMA_VERSION) {
    return yield* initError(
      `SQLite schema version is ${String(version)}; this build requires ${LATEST_SCHEMA_VERSION}`
    )
  }
})

const probeModelSettingsSingleton = Effect.fn("SqlitePersistence.probeModelSettingsSingleton")(
  function* (sql: SqlClient.SqlClient) {
    const rows = yield* sql<{ readonly singleton_id: number }>`
    SELECT singleton_id FROM model_settings
  `.pipe(
      Effect.mapError((cause) => initError("Could not inspect the model settings singleton", cause))
    )
    if (rows.length !== 1 || rows[0]?.singleton_id !== 1) {
      return yield* initError("SQLite model settings singleton is not the current baseline")
    }
  }
)

const initializeSchema = Effect.fn("SqlitePersistence.initializeSchema")(function* (
  sql: SqlClient.SqlClient
) {
  yield* configureConnection(sql)
  yield* sql
    .unsafe("PRAGMA foreign_keys = ON")
    .pipe(Effect.mapError((cause) => initError("Could not enable SQLite foreign keys", cause)))
  const existing = yield* sql<{ readonly present: number }>`
    SELECT 1 AS present FROM sqlite_schema
    WHERE name NOT GLOB 'sqlite_*'
    LIMIT 1
  `.pipe(Effect.mapError((cause) => initError("Could not inspect SQLite schema", cause)))
  if (existing.length === 0) {
    yield* prepareFreshStorage(sql)
    yield* sql
      .withTransaction(
        Effect.forEach(databaseSchema.statements, (statement) => sql.unsafe(statement), {
          discard: true
        }).pipe(Effect.andThen(sql.unsafe(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`)))
      )
      .pipe(Effect.mapError((cause) => initError("Could not initialize SQLite schema", cause)))
  }
  yield* probeSchemaManifest(sql)
  yield* probeSchemaVersion(sql)
  yield* probeModelSettingsSingleton(sql)
})

interface BuiltStores {
  readonly filename: string
  readonly dataDir: string | null
  readonly deps: PersistenceDeps
  readonly writes: PersistenceWriteQueue["Service"]
  readonly automationRules: AutomationRules["Service"]
  readonly chatRules: ChatRules["Service"]
  readonly catalog: ModelCatalog["Service"]
  readonly intelligence: IntelligenceSettingsStore["Service"]
  readonly limits: LimitSettingsStore["Service"]
  readonly embeddingSettings: EmbeddingSettingsStore["Service"]
  readonly modelEndpoints: ModelEndpointStore["Service"]
  readonly models: ModelStore["Service"]
  readonly storagePolicy: StoragePolicyStore["Service"]
  readonly usage: UsageStore["Service"]
  readonly relay: RelayStore["Service"]
}

const persistencePorts = (built: BuiltStores) => {
  const { deps, catalog, intelligence, storagePolicy, writes } = built
  const tools = makeToolStores({
    ...deps,
    dataDir: built.dataDir
  })
  const automations = makeAutomationStores({ ...deps, rules: built.automationRules })
  const proposals = withTaskProposalReview(makeTaskProposalStore(deps), automations.spaceReviews)
  return Context.mergeAll(
    Context.make(
      Persistence,
      Persistence.of({
        recoverAfterRestart: interruptActiveChatRunsAfterRestart(deps),
        retentionTick: deps.sessionEvents.pruneSupersededSnapshots().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Superseded Session snapshot pruning failed", cause)
          ),
          Effect.andThen(compactExpiredAgentSessions({ ...deps, policy: storagePolicy })),
          Effect.andThen(trimJournals({ ...deps, policy: storagePolicy })),
          Effect.asVoid
        ),
        consistentRead: writes.runInteractive,
        drain: writes.flush
      })
    ),
    Context.make(PersistenceWriteQueue, writes),
    Context.make(ChatEventStore, deps.chatEvents),
    Context.make(SessionLifecycleEvents, deps.sessionEvents),
    Context.make(AutomationCatalog, automations.catalog),
    Context.make(AutomationQueue, automations.queue),
    Context.make(AutomationTriggers, automations.triggers),
    Context.make(WikiEventOutbox, automations.wikiOutbox),
    Context.make(HomeLetterInputs, automations.homeLetterInputs),
    Context.make(SpaceReviewStore, automations.spaceReviews),
    Context.make(AutomationHandlerItems, automations.handlerItems),
    Context.make(SpaceStore, makeSpaceStore(deps)),
    Context.make(HomeStore, makeHomeStore(deps)),
    Context.make(WorkStore, makeWorkStore(deps)),
    Context.make(TaskProposalStore, proposals),
    Context.make(ConnectionItemStore, makeConnectionItemStore(deps)),
    Context.make(CapabilityOfferStore, makeCapabilityOfferStore(deps)),
    Context.make(FocusChoiceStore, makeFocusChoiceStore(deps)),
    Context.make(CommunicationStore, makeCommunicationStore(deps)),
    Context.make(SessionQueries, makeSessionQueries(deps)),
    Context.make(SessionStore, makeSessionStore(deps)),
    Context.make(TranscriptQueries, makeTranscriptQueries(deps)),
    Context.make(SessionTurnQueries, makeSessionTurnQueries(deps)),
    Context.make(SessionReadState, makeSessionReadState(deps)),
    Context.make(RunQueries, makeRunQueries(deps)),
    Context.make(
      ChatWriteStore,
      makeChatWriteStore({
        ...deps,
        catalog,
        intelligence,
        limits: built.limits,
        rules: built.chatRules
      })
    ),
    Context.make(ToolExecutionStore, tools.executions),
    Context.make(ToolHistoryQueries, tools.history),
    Context.make(ApprovalPolicyStore, makeApprovalPolicyStore(deps)),
    Context.make(DeferredToolCalls, makeDeferredToolCalls(deps)),
    Context.make(TodoStore, makeTodoStore(deps)),
    Context.make(AnswerBlockStore, makeAnswerBlockStore(deps)),
    Context.make(SummaryStore, makeSummaryStore(deps)),
    Context.make(InboxStore, makeInboxStore(deps)),
    Context.make(ModelStore, built.models),
    Context.make(ModelCatalog, catalog),
    Context.make(ContextCompactionStore, makeContextCompactionStore(deps)),
    Context.make(WikiRenameStore, makeWikiRenameStore(deps)),
    Context.make(WikiMaintenanceStore, makeWikiMaintenanceStore(deps)),
    Context.make(MemoryCaptureStore, makeMemoryCaptureStore(deps)),
    Context.make(WikiEmbeddingStore, makeWikiEmbeddingStore(deps)),
    Context.make(McpStore, makeMcpStore(deps)),
    Context.make(PermissionStore, makePermissionStore(deps)),
    Context.make(PermissionRules, makePermissionRules(deps)),
    Context.make(AuthorityHistoryStore, makeAuthorityHistoryStore(deps)),
    Context.make(StoragePolicyStore, storagePolicy),
    Context.make(StorageSessionStore, makeStorageSessionStore(deps, built.filename)),
    Context.make(IntelligenceSettingsStore, intelligence),
    Context.make(LimitSettingsStore, built.limits),
    Context.make(EmbeddingSettingsStore, built.embeddingSettings),
    Context.make(ModelEndpointStore, built.modelEndpoints),
    Context.make(UsageStore, built.usage),
    Context.make(RelayStore, built.relay),
    Context.make(ScriptStore, makeScriptStore(deps)),
    Context.make(BrowserProcedureStore, makeBrowserProcedureStore(deps)),
    Context.make(DriveUploadStore, makeDriveUploadStore(deps)),
    Context.make(ScriptResults, makeScriptResults(deps)),
    Context.make(ScriptJournal, makeScriptJournal(deps)),
    Context.make(ManagedOutputLifecycleStore, makeManagedOutputLifecycleStore(deps)),
    Context.make(BackfillStore, makeBackfillRuntime(deps))
  )
}

export type SqlitePersistence =
  ReturnType<typeof persistencePorts> extends Context.Context<infer Ports> ? Ports : never

export const sqliteStoresLayer = (
  options: SqlitePersistenceOptions
): Layer.Layer<
  SqlitePersistence,
  StorageStartupError,
  PersistenceWriteQueue | AutomationRules | ChatRules
> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const writes = yield* PersistenceWriteQueue
      const automationRules = yield* AutomationRules
      const chatRules = yield* ChatRules
      const diagnostics = yield* Diagnostics
      yield* initializeSchema(sql)
      yield* initializeSearchIndex(sql, options.filename).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((cause) => initError("Could not initialize the search database", cause))
      )
      const record = options.record
      if (record !== undefined) yield* recordDataVersion(record.storage, record.version)
      yield* installCapture(sql).pipe(
        Effect.mapError((cause) => initError("Could not set up change capture", cause))
      )
      yield* diagnostics.startupPhase("schema_ready")
      // HTTP-facing reads get their own read-only connections. WAL lets them
      // read the last commit while the writer holds a transaction, so a long
      // write no longer queues every list and history read behind the writer's
      // lock; and four of them, each on its own thread, let one slow read (a big
      // chat opening on a cold cache) run beside the others instead of in front.
      // Reads inside a write transaction stay on `sql`; an in-memory database
      // has only one connection.
      const reader =
        options.filename === ":memory:"
          ? sql
          : yield* makeSqliteThreadClient({
              filename: options.filename,
              readonly: true,
              connections: 4
            }).pipe(Effect.provide(Reactivity.layer))
      let tellAtCommit: Effect.Effect<void, never, UnitOfWork> | undefined
      const writer = makeWriter({ sql, reader, queue: writes, beforeCommit: () => tellAtCommit })
      const intelligence = yield* makeIntelligenceSettingsStore({ writer }).pipe(
        Effect.mapError((cause) =>
          initError("Could not construct intelligence settings storage", cause)
        )
      )
      const embeddingSettings = yield* makeEmbeddingSettingsStore({ writer }).pipe(
        Effect.mapError((cause) =>
          initError("Could not construct embedding settings storage", cause)
        )
      )
      const modelEndpoints = yield* makeModelEndpointStore({ writer }).pipe(
        Effect.mapError((cause) => initError("Could not construct model endpoint storage", cause))
      )
      const catalog = yield* makeModelCatalog({
        host: options.models,
        refresh: options.refreshModelHost,
        install: makeModelDefaultsSeed({ writer })
      }).pipe(
        Effect.mapError((cause) => initError("Could not construct model settings storage", cause))
      )
      const models = makeModelStore({ writer, catalog, intelligence })
      const journalRuntime = yield* makeJournalRuntime(sql, {
        initialize: false,
        subscriberCapacity: 4_096
      }).pipe(Effect.mapError((cause) => initError("Could not construct journal runtime", cause)))
      const storagePolicy = yield* makeStoragePolicyStore({ writer }).pipe(
        Effect.mapError((cause) => initError("Could not construct Storage policy", cause))
      )
      const chatEvents = makeChatEventStore({ writer, journal: journalRuntime })
      const sessionEvents = makeSessionLifecycleEvents({
        writer,
        journal: journalRuntime,
        chatEvents
      })
      tellAtCommit = makeTellAtCommit({ sql, sessionEvents, chatEvents })
      const deps: PersistenceDeps = { writer, reader, chatEvents, sessionEvents, diagnostics }
      const limits = yield* makeLimitSettingsStore(deps).pipe(
        Effect.mapError((cause) => initError("Could not construct limit settings storage", cause))
      )
      const usage = yield* makeUsageStore(deps).pipe(
        Effect.mapError((cause) => initError("Could not construct usage storage", cause))
      )
      const relay = yield* makeRelayStore(deps).pipe(
        Effect.mapError((cause) => initError("Could not construct relay storage", cause))
      )
      const ports = persistencePorts({
        filename: options.filename,
        dataDir: options.dataDir,
        deps,
        writes,
        automationRules,
        chatRules,
        catalog,
        intelligence,
        limits,
        embeddingSettings,
        modelEndpoints,
        models,
        storagePolicy,
        usage,
        relay
      })
      const fileLifecycle = Context.get(ports, ManagedOutputLifecycleStore)
      yield* Effect.addFinalizer(() => Effect.promise(fileLifecycle.drain))
      yield* diagnostics.startupPhase("persistence_ready")
      return ports
    })
  ).pipe(
    Layer.provide(
      Layer.unwrap(
        migrateAtStartup(options.filename).pipe(
          Effect.as(sqliteWriterLayer({ filename: options.filename }))
        )
      )
    )
  )
