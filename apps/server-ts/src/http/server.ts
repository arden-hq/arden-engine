import { contextExperimentsLayer } from "../context/experiments.js"
import { SourceTitleHandlers } from "./source-titles/handlers.js"
import { retryingFetch } from "@arden-hq/loop/provider-kit"
import { ProcessHandlers } from "./processes/handlers.js"
import { join } from "node:path"
import { ComputerService } from "../computer/service.js"
import { ComputerHandlers } from "./computer/handlers.js"
import { TaskProposalHandlers } from "./task-proposals/handlers.js"
import { FocusChoiceHandlers } from "./focus-choices/handlers.js"
import { AnswerBlockHandlers } from "./answer-blocks/handlers.js"
import { WorkerStatus } from "../automations/worker-status.js"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import { BrowserClient } from "../browser/service.js"
import { embeddingModelsLayer } from "../embedding/models.js"
import { LOCAL_EMBEDDING_MODELS } from "../local-models/catalog.js"
import { llamaServerLayer } from "../local-models/llama-server.js"
import { localEmbeddingSource } from "../local-models/local-embedding-model.js"
import {
  installedPresetModels,
  isInstalled,
  localDecisionEndpointLayer,
  localModelsLayer
} from "../local-models/service.js"
import { wikiEmbeddingIndexLayer } from "../embedding/wiki-index.js"
import type { ServerConfigShape } from "../config/service.js"
import { ServerConfig } from "../config/service.js"
import { ChatEventStream } from "../chat/events.js"
import { ChatStop } from "../chat/chat-stop.js"
import { ChatMessage } from "../chat/message.js"
import { ChatHistory } from "../chat/history.js"
import { makeBuiltInChatRunners } from "../chat/runner/built-in.js"
import { idleCompactionRuntime } from "../context/idle-runtime.js"
import { ContextCompaction } from "../context/service.js"
import type { ModelHostSource } from "../models/host.js"
import type { HostedServerOptions } from "../config/options.js"
import { StructuredCompletion } from "../models/structured-completion.js"
import { Decisions } from "../models/decisions/service.js"
import { ModelEndpoints } from "../models/endpoints/service.js"
import { ModelEndpointHandlers } from "./model-endpoints/handlers.js"
import { ModelProviderService } from "../models/provider.js"
import { PlanLimitNotices } from "../limits/notices.js"
import { ModelProviderSwitch } from "../models/provider-switch.js"
import { skillCatalogLayer } from "../skills/service.js"
import { storageMaintenanceLayer } from "../storage/service.js"
import { Memory } from "../memory/service.js"
import { mcpConnectionsLayer } from "../mcp/service.js"
import { googleConnectionsLayer } from "../google/service.js"
import { PersistenceWriteQueue } from "../persistence/write-queue.js"
import {
  prepareReleaseStorage,
  recoveredSqlitePersistenceLayer,
  type SqlitePersistenceOptions
} from "../runtime/persistence-layer.js"
import { RegistryWorkflowHost, ServerToolRegistry } from "../tools/registry.js"
import { ManagedOutputs } from "../artifacts/managed-output/managed-output.js"
import { wikiLayer } from "../wiki/service.js"
import { automationWikiChangeSinkLayer } from "../automations/wiki-change-sink.js"
import { ArdenApi } from "./api.js"
import { RunHandlers } from "./runs/handlers.js"
import { AutomationHandlers } from "./automations/handlers.js"
import { ChatHandlers } from "./chat/handlers.js"
import { ConfigHandlers } from "./config/handlers.js"
import { ContextHandlers } from "./context/handlers.js"
import { ContinuityHandlers } from "./continuity/handlers.js"
import { SpaceHandlers } from "./spaces/handlers.js"
import { EmbeddingHandlers } from "./embeddings/handlers.js"
import { LocalModelHandlers } from "./local-models/handlers.js"
import { HealthHandlers } from "./health/handlers.js"
import { GoogleHandlers } from "./google/handlers.js"
import { InboxHandlers } from "./inbox/handlers.js"
import { IntelligenceSettingsHandlers } from "./intelligence-settings/handlers.js"
import { LimitSettingsHandlers } from "./limit-settings/handlers.js"
import { ModelHandlers } from "./models/handlers.js"
import { McpHandlers } from "./mcp/handlers.js"
import { PermissionHandlers } from "./permissions/handlers.js"
import { SessionHandlers } from "./sessions/handlers.js"
import { SkillHandlers } from "./skills/handlers.js"
import { StorageHandlers } from "./storage/handlers.js"
import { TodoHandlers } from "./todos/handlers.js"
import { ToolHandlers } from "./tools/handlers.js"
import { WorkHandlers } from "./work/handlers.js"
import { ScriptHandlers } from "./scripts/handlers.js"
import { WikiHandlers } from "./wiki/handlers.js"
import { TerminalHandlers } from "./terminals/handlers.js"
import { MobileHandlers } from "./mobile/handlers.js"
import { RelayHandlers } from "./relay/handlers.js"
import { relayLayer } from "../relay/service.js"
import { CliToolHandlers } from "./cli-tools/handlers.js"
import { cliToolsLayer } from "../cli-tools/service.js"
import { AutomationRuntime } from "../automations/runtime.js"
import { AutomationTriggerProducersRuntime } from "../automations/trigger-producers-runtime.js"
import { CommunicationDeliveryRuntime } from "../continuity/delivery-runtime.js"
import { WorkArrivalsRuntime } from "../work/arrivals-runtime.js"
import { connectionItemsRuntime } from "../connections/items/runtime.js"
import { capabilityOfferRuntime } from "../mcp/offer-runtime.js"
import { mcpChangeFeedRuntime } from "../mcp/change-feed.js"
import { makeRouteStep } from "../connections/items/route-step.js"
import { makeLocalOnlyMiddleware } from "./middleware/local-only.js"
import { commandLineAccess } from "./middleware/command-line-access.js"
import { RequestIdMiddleware } from "./middleware/request-id.js"
import { BootIdMiddleware } from "./middleware/boot-id.js"
import { ServerLifecycle, serverLifecycleLayer } from "../runtime/lifecycle.js"
import { LifecycleMiddleware } from "./middleware/lifecycle.js"
import { globalInstructionsLayer } from "../context/global-instructions.js"
import { BrowserProcedures } from "../browser/procedures/service.js"
import { BrowserProcedureRuntime } from "../browser/procedures/runtime.js"
import { BrowserProcedureHandlers } from "./browser-procedures/handlers.js"
import { ScriptRunner } from "../workflows/script-runner.js"
import { ScriptBoot } from "../workflows/script-boot.js"
import { DeferredCalls } from "../tools/deferred-calls.js"
import { ResearchWorkspace } from "../research/workspace.js"
import { ConversationArtifacts } from "../artifacts/conversation.js"
import { SessionFileCleanup } from "../storage/session-file-cleanup.js"
import { Diagnostics } from "../runtime/diagnostics.js"
import { BackfillStore } from "../persistence/backfills/store.js"
import { EventLoopMonitor } from "../runtime/event-loop-monitor.js"
import { DataRoot, dataRootLayer, type DataRootShape } from "../runtime/data-root.js"
import { TerminalSessions } from "../terminals/service.js"
import { TerminalNoticesRuntime } from "../terminals/notices.js"
import { ArchivePendingRuntime } from "../chat/archive-pending-runtime.js"
import { QueueDispatchRuntime, QueueHold } from "../chat/queue-dispatch-runtime.js"
import { SessionForkRecovery } from "../chat/session-fork.js"
import { FencedScriptsRuntime } from "../workflows/fenced-scripts-runtime.js"
import {
  takeRestartNotices,
  acknowledgeTerminalNotice,
  terminalsFile
} from "../terminals/restart-notices.js"

export type ServerLayerOptions = Omit<HostedServerOptions, "modelHost"> & {
  readonly modelHost?: ModelHostSource | undefined
}

const composeServer = (
  config: ServerConfigShape,
  root: DataRootShape,
  options: ServerLayerOptions,
  record: SqlitePersistenceOptions["record"]
) => {
  const modelProvider = ModelProviderService.layer({
    provider: options.provider,
    structuredOutputDialect: options.structuredOutputDialect,
    planLimits: options.planLimits,
    approvalReview: options.approvalReview,
    transcription: options.transcription
  })
  const storage = recoveredSqlitePersistenceLayer({
    filename: root.databaseFile,
    dataDir: root.dir,
    record,
    models: options.modelHost,
    refreshModelHost: options.refreshModelHost
  }).pipe(Layer.provide(PersistenceWriteQueue.layer))
  const context = ContextCompaction.layer.pipe(
    Layer.provide(modelProvider),
    Layer.provide(storage),
    Layer.provide(Layer.succeed(ServerConfig, ServerConfig.of(config)))
  )
  const wiki = wikiLayer(root.wiki).pipe(
    Layer.provide(automationWikiChangeSinkLayer),
    Layer.provide(storage)
  )
  const skills = skillCatalogLayer(root.skills, { extraRoots: config.sharedSkillRoots })
  const globalInstructions = globalInstructionsLayer(root.globalInstructions)
  const cliTools = cliToolsLayer({ warm: config.data.kind === "disk" }).pipe(Layer.provide(skills))
  const modelsRoot = join(root.dir, "models")
  const llama = llamaServerLayer({
    binary: config.llamaServer,
    root: modelsRoot,
    models: () => installedPresetModels(modelsRoot)
  })
  const embeddingModels = Layer.unwrap(
    Effect.forEach(LOCAL_EMBEDDING_MODELS, (manifest) =>
      localEmbeddingSource(manifest, () => isInstalled(modelsRoot, manifest))
    ).pipe(Effect.map(embeddingModelsLayer))
  ).pipe(Layer.provide(llama))
  const localDecision = localDecisionEndpointLayer(modelsRoot).pipe(Layer.provide(llama))
  const modelEndpoints = ModelEndpoints.layer({
    vault: options.credentialVault,
    fetch: retryingFetch(globalThis.fetch)
  }).pipe(Layer.provideMerge(embeddingModels), Layer.provide(localDecision), Layer.provide(storage))
  const embeddings = wikiEmbeddingIndexLayer.pipe(
    Layer.provide(modelEndpoints),
    Layer.provide(storage),
    Layer.provide(wiki)
  )
  const localModels = localModelsLayer({ root: modelsRoot }).pipe(
    Layer.provide(llama),
    Layer.provide(embeddings)
  )
  const artifacts = ConversationArtifacts.layer(root.conversations)
  const mcp = mcpConnectionsLayer(options.credentialVault).pipe(Layer.provide(storage))
  const google = googleConnectionsLayer({
    vault: options.credentialVault,
    oauthClient: options.googleOAuthClient
  })
  const browser = BrowserClient.layer(options.browserBroker).pipe(Layer.provide(storage))
  const computer = ComputerService.layer({
    pauseFile: root.computerPause,
    installRoot: root.computer
  })
  const providerSwitch = ModelProviderSwitch.layer.pipe(
    Layer.provide(modelProvider),
    Layer.provide(storage)
  )
  const completion = StructuredCompletion.layer.pipe(
    Layer.provide(modelProvider),
    Layer.provide(storage)
  )
  const decisions = Decisions.layer.pipe(
    Layer.provide(completion),
    Layer.provide(modelEndpoints),
    Layer.provide(storage)
  )
  const research = ResearchWorkspace.layer(root.research)
  const outputs = ManagedOutputs.layer(root.managedOutputs).pipe(Layer.provide(storage))
  const workflows = ScriptRunner.layer.pipe(Layer.provide(outputs), Layer.provide(storage))
  const procedures = BrowserProcedures.layer.pipe(
    Layer.provide(completion),
    Layer.provide(workflows),
    Layer.provide(storage)
  )
  const cleanup = SessionFileCleanup.layer(root.uploads).pipe(
    Layer.provide(outputs),
    Layer.provide(artifacts),
    Layer.provide(storage)
  )
  const storageMaintenance = storageMaintenanceLayer({
    root: root.dir,
    databaseName: root.databaseName
  }).pipe(Layer.provide(storage), Layer.provide(artifacts), Layer.provide(cleanup))
  const workerStatus = WorkerStatus.layer
  const terminals = TerminalSessions.layer
  const tools = ServerToolRegistry.layer.pipe(
    Layer.provide(terminals),
    Layer.provide(modelProvider),
    Layer.provide(workerStatus),
    Layer.provide(completion),
    Layer.provide(decisions),
    Layer.provide(browser),
    Layer.provide(computer),
    Layer.provide(google),
    Layer.provide(mcp),
    Layer.provide(skills),
    Layer.provide(globalInstructions),
    Layer.provide(wiki),
    Layer.provide(workflows),
    Layer.provide(procedures),
    Layer.provide(research),
    Layer.provide(artifacts),
    Layer.provide(outputs),
    Layer.provide(storage),
    Layer.tap(() => Diagnostics.use((diagnostics) => diagnostics.startupPhase("tools_ready")))
  )
  const baseServices = Layer.mergeAll(
    contextExperimentsLayer,
    modelProvider,
    workerStatus,
    storage,
    storageMaintenance,
    mcp,
    google,
    browser,
    computer,
    tools,
    RegistryWorkflowHost.pipe(Layer.provide(tools)),
    context,
    completion,
    decisions,
    modelEndpoints,
    wiki,
    skills,
    cliTools,
    globalInstructions,
    embeddings,
    localModels,
    llama,
    workflows,
    procedures,
    research,
    artifacts,
    outputs,
    cleanup,
    terminals,
    PlanLimitNotices.pipe(Layer.provide(modelProvider), Layer.provide(storage)),
    Layer.effectDiscard(
      Effect.gen(function* () {
        const backfills = yield* BackfillStore
        const lifecycle = yield* ServerLifecycle
        yield* lifecycle.background(Effect.sleep("10 seconds").pipe(Effect.andThen(backfills.run)))
      })
    ).pipe(Layer.provide(storage))
  ).pipe(
    Layer.tap(() => Diagnostics.use((diagnostics) => diagnostics.startupPhase("services_ready")))
  )
  const memory = Memory.layer().pipe(Layer.provide(baseServices))
  const services = Layer.merge(baseServices, memory)
  const message = Layer.unwrap(
    Effect.gen(function* () {
      const root = yield* DataRoot
      const boot = {
        arrivals: () => takeRestartNotices(root.dir),
        acknowledgeArrival: (arrival: { readonly sessionId: string; readonly clientId: string }) =>
          acknowledgeTerminalNotice(terminalsFile(root.dir), arrival.sessionId, arrival.clientId)
      }
      if (options.runner !== undefined) return ChatMessage.layer({ runner: options.runner }, boot)
      return ChatMessage.layer({ runnerFor: yield* makeBuiltInChatRunners() }, boot)
    })
  )
  const history = ChatHistory.modelLayer
  const chat = Layer.mergeAll(
    history,
    Layer.merge(
      ChatEventStream.layer.pipe(Layer.provide(history)),
      ChatStop.layer.pipe(Layer.provideMerge(message))
    ),
    QueueHold.layer
  ).pipe(Layer.provide(services))
  const automations = AutomationRuntime.layer.pipe(Layer.provide(chat), Layer.provide(services))
  const loopLayers = Layer.mergeAll(
    idleCompactionRuntime({ enabled: config.idleCompactionAfterMs > 0 }),
    EventLoopMonitor,
    WorkArrivalsRuntime,
    TerminalNoticesRuntime,
    ArchivePendingRuntime,
    QueueDispatchRuntime,
    SessionForkRecovery,
    FencedScriptsRuntime,
    BrowserProcedureRuntime,
    CommunicationDeliveryRuntime,
    AutomationTriggerProducersRuntime,
    connectionItemsRuntime({ power: options.power, makeAfterFetch: makeRouteStep }),
    capabilityOfferRuntime,
    mcpChangeFeedRuntime
  ).pipe(Layer.provide(chat), Layer.provide(services))
  const workflowBoot = ScriptBoot.pipe(Layer.provide(chat), Layer.provide(services))
  const backgroundLoops = Layer.effectDiscard(
    Effect.gen(function* () {
      const lifecycle = yield* ServerLifecycle
      const automation = yield* AutomationRuntime
      yield* lifecycle.background(
        automation.awaitReady.pipe(
          Effect.andThen(Layer.build(Layer.merge(loopLayers, workflowBoot))),
          Effect.andThen(Effect.never)
        )
      )
    })
  ).pipe(Layer.provideMerge(automations))
  const deferredCalls = DeferredCalls.layer.pipe(Layer.provide(chat), Layer.provide(services))
  const runtime = Layer.mergeAll(chat, backgroundLoops, deferredCalls)
  const transport = NodeHttpServer.layer(createServer, {
    host: config.hostname,
    port: config.port,
    disablePreemptiveShutdown: true
  })
  const relay = relayLayer({
    vault: options.credentialVault,
    localAccess: options.localAccess,
    power: options.power
  }).pipe(Layer.provide(transport), Layer.provide(storage))
  const handlers = Layer.merge(
    HealthHandlers,
    Layer.mergeAll(
      ComputerHandlers,
      RunHandlers,
      AutomationHandlers,
      ChatHandlers,
      ConfigHandlers,
      ContextHandlers,
      ContinuityHandlers,
      SpaceHandlers,
      TaskProposalHandlers,
      FocusChoiceHandlers,
      AnswerBlockHandlers,
      EmbeddingHandlers,
      LocalModelHandlers,
      ModelEndpointHandlers,
      GoogleHandlers,
      InboxHandlers,
      IntelligenceSettingsHandlers,
      LimitSettingsHandlers,
      ModelHandlers,
      McpHandlers,
      PermissionHandlers,
      SessionHandlers,
      SkillHandlers,
      StorageHandlers,
      TodoHandlers,
      ToolHandlers,
      WorkHandlers,
      ScriptHandlers,
      BrowserProcedureHandlers,
      WikiHandlers,
      TerminalHandlers,
      ProcessHandlers,
      SourceTitleHandlers,
      MobileHandlers,
      RelayHandlers,
      CliToolHandlers
    ).pipe(Layer.provide(relay), Layer.provide(runtime), Layer.provide(services))
  )
  const apiRoutes = HttpApiBuilder.layer(ArdenApi).pipe(
    Layer.provide(handlers),
    Layer.provide(commandLineAccess.pipe(Layer.provide(services))),
    Layer.provide(LifecycleMiddleware),
    Layer.provide(RequestIdMiddleware),
    Layer.provide(makeLocalOnlyMiddleware(options.localAccess)),
    Layer.provide(BootIdMiddleware)
  )
  const served = HttpRouter.serve(apiRoutes, {
    disableListenLog: true
  }).pipe(
    Layer.provide(transport),
    Layer.provide(Layer.succeed(ServerConfig, ServerConfig.of(config))),
    Layer.provide(modelProvider)
  )
  return Layer.mergeAll(transport, served, chat, providerSwitch)
}

export const serverLayer = (config: ServerConfigShape, options: ServerLayerOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const root = yield* DataRoot
      const record =
        root.databaseName === null
          ? undefined
          : yield* prepareReleaseStorage(root.databaseFile, {
              appVersion: config.version,
              dataDir: root.dir
            })
      return composeServer(config, root, options, record)
    })
  ).pipe(Layer.provide(dataRootLayer(config.data)), Layer.provideMerge(serverLifecycleLayer))
