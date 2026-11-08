import { processRoutes } from "@arden-hq/protocol/processes"
import { readdirSync } from "node:fs"
import { HttpApi } from "effect/unstable/httpapi"
import { expect, it } from "vitest"
import { automationRoutes } from "@arden-hq/protocol/automations"
import { browserProcedureRoutes } from "@arden-hq/protocol/browser-procedures"
import { chatRoutes } from "@arden-hq/protocol/chat"
import { cliToolRoutes } from "@arden-hq/protocol/cli-tools"
import { computerRoutes } from "@arden-hq/protocol/computer"
import { contextRoutes } from "@arden-hq/protocol/context"
import { spaceRoutes } from "@arden-hq/protocol/spaces"
import { spaceContinuityRoutes } from "@arden-hq/protocol/spaces/continuity"
import { workRoutes } from "@arden-hq/protocol/spaces/work"
import { embeddingRoutes } from "@arden-hq/protocol/embeddings"
import { googleRoutes } from "@arden-hq/protocol/google"
import { healthRoutes } from "@arden-hq/protocol/health"
import { inboxRoutes } from "@arden-hq/protocol/inbox"
import { localModelsRoutes } from "@arden-hq/protocol/local-models"
import { mcpRoutes } from "@arden-hq/protocol/mcp"
import { mobileRoutes } from "@arden-hq/protocol/mobile"
import { modelEndpointRoutes } from "@arden-hq/protocol/model-endpoints"
import { modelRoutes } from "@arden-hq/protocol/models"
import { permissionRoutes } from "@arden-hq/protocol/permissions"
import { taskProposalRoutes } from "@arden-hq/protocol/proposals"
import { relayRoutes } from "@arden-hq/protocol/relay"
import { runRoutes } from "@arden-hq/protocol/runs"
import { sessionRoutes } from "@arden-hq/protocol/sessions"
import { answerBlockRoutes } from "@arden-hq/protocol/sessions/answer-blocks"
import { focusChoiceRoutes } from "@arden-hq/protocol/sessions/focus-choices"
import { terminalRoutes } from "@arden-hq/protocol/sessions/terminals"
import { todoRoutes } from "@arden-hq/protocol/sessions/todos"
import { intelligenceSettingsRoutes, limitSettingsRoutes } from "@arden-hq/protocol/settings"
import { skillRoutes } from "@arden-hq/protocol/skills"
import { storageRoutes } from "@arden-hq/protocol/storage"
import { toolRoutes } from "@arden-hq/protocol/tools"
import { wikiRoutes } from "@arden-hq/protocol/wiki"
import { scriptRoutes } from "@arden-hq/protocol/workflows"
import { ArdenApi } from "../src/http/api.js"

type Builders<R> = {
  readonly [K in keyof R as R[K] extends string ? never : K]: () => string
}

interface RouteTable {
  readonly paths: ReadonlyArray<readonly [name: string, path: string]>
}

const table = <R extends object>(
  routes: R,
  builders: Builders<R> & Readonly<Record<string, () => string>>
): RouteTable => ({
  paths: [
    ...Object.entries(routes).flatMap(([name, value]) =>
      typeof value === "string" ? [[name, value] as const] : []
    ),
    ...Object.entries(builders).map(([name, build]) => [name, build()] as const)
  ]
})

const sessionId = "session-1"
const spaceId = "space-1"
const itemId = "item-1"
const workflowTarget = { workflowRef: "workflow-1", sessionId }

const tables: Readonly<Record<string, RouteTable>> = {
  automationRoutes: table(automationRoutes, {
    events: () => automationRoutes.events(),
    item: () => automationRoutes.item("task-1"),
    description: () => automationRoutes.description("task-1"),
    runs: () => automationRoutes.runs("task-1"),
    toggle: () => automationRoutes.toggle("task-1"),
    run: () => automationRoutes.run("task-1"),
    runWithEvent: () => automationRoutes.runWithEvent("task-1", 7),
    reset: () => automationRoutes.reset("task-1")
  }),
  browserProcedureRoutes: table(browserProcedureRoutes, {
    detail: () => browserProcedureRoutes.detail("procedure-1"),
    procedure: () => browserProcedureRoutes.procedure("procedure-1")
  }),
  chatRoutes: table(chatRoutes, {
    history: () => chatRoutes.history({ sessionId }),
    turnWork: () => chatRoutes.turnWork({ sessionId, turnId: "turn-1" }),
    turnDetails: () => chatRoutes.turnDetails({ sessionId, turnId: "turn-1" }),
    toolCall: () => chatRoutes.toolCall({ sessionId, turnId: "turn-1", toolCallId: "call-1" }),
    toolResultValue: () =>
      chatRoutes.toolResultValue({ sessionId, toolCallId: "call-1", path: "items.0" }),
    markRead: () => chatRoutes.markRead({ sessionId }),
    events: () => chatRoutes.events(sessionId),
    queue: () => chatRoutes.queue(sessionId),
    queuedMessage: () => chatRoutes.queuedMessage({ sessionId, clientId: "client-1" })
  }),
  cliToolRoutes: table(cliToolRoutes, {}),
  computerRoutes: table(computerRoutes, {}),
  contextRoutes: table(contextRoutes, { experiments: () => contextRoutes.experiments(sessionId) }),
  spaceRoutes: table(spaceRoutes, {
    item: () => spaceRoutes.item(spaceId),
    archive: () => spaceRoutes.archive(spaceId, { stop: true }),
    overviewHistory: () => spaceRoutes.overviewHistory(spaceId),
    conversation: () => spaceRoutes.conversation(spaceId),
    page: () => spaceRoutes.page(spaceId),
    restore: () => spaceRoutes.restore(spaceId),
    instructions: () => spaceRoutes.instructions(spaceId)
  }),
  spaceContinuityRoutes: table(spaceContinuityRoutes, {
    state: () => spaceContinuityRoutes.state(spaceId),
    acknowledge: () => spaceContinuityRoutes.acknowledge(spaceId)
  }),
  taskProposalRoutes: table(taskProposalRoutes, {
    list: () => taskProposalRoutes.list({ place: "space", spaceId }),
    recheck: () => taskProposalRoutes.recheck("proposal-1"),
    resolve: () => taskProposalRoutes.resolve("proposal-1")
  }),
  workRoutes: table(workRoutes, {
    taskChat: () => workRoutes.taskChat(itemId),
    resultRead: () => workRoutes.resultRead(itemId),
    page: () => workRoutes.page(),
    attachment: () => workRoutes.attachment(7),
    collection: () => workRoutes.collection(spaceId),
    looseCollection: () => workRoutes.looseCollection(),
    chatTask: () => workRoutes.chatTask(sessionId),
    item: () => workRoutes.item(itemId),
    stop: () => workRoutes.stop(itemId),
    comment: () => workRoutes.comment(itemId),
    attachmentUpload: () => workRoutes.attachmentUpload(itemId)
  }),
  embeddingRoutes: table(embeddingRoutes, {}),
  googleRoutes: table(googleRoutes, {
    oauth: () => googleRoutes.oauth("gmail"),
    disconnect: () => googleRoutes.disconnect("gmail", "account-1"),
    grant: () => googleRoutes.grant("account-1", "gmail_drafts")
  }),
  healthRoutes: table(healthRoutes, {}),
  modelEndpointRoutes: table(modelEndpointRoutes, {
    endpoint: () => modelEndpointRoutes.endpoint("search"),
    check: () => modelEndpointRoutes.check("decision")
  }),
  inboxRoutes: table(inboxRoutes, {}),
  localModelsRoutes: table(localModelsRoutes, {
    install: () => localModelsRoutes.install("model-1"),
    stop: () => localModelsRoutes.stop("model-1"),
    remove: () => localModelsRoutes.remove("model-1")
  }),
  mcpRoutes: table(mcpRoutes, {
    installPreset: () => mcpRoutes.installPreset("github"),
    server: () => mcpRoutes.server("server-1"),
    enabled: () => mcpRoutes.enabled("server-1"),
    reconnect: () => mcpRoutes.reconnect("server-1"),
    oauth: () => mcpRoutes.oauth("server-1"),
    offers: () => mcpRoutes.offers("session-1")
  }),
  mobileRoutes: table(mobileRoutes, {
    conversation: () => mobileRoutes.conversation(sessionId, "cursor-1"),
    turn: () => mobileRoutes.turn(sessionId, "turn-1")
  }),
  modelRoutes: table(modelRoutes, {}),
  permissionRoutes: table(permissionRoutes, {
    session: () => permissionRoutes.session(sessionId),
    spaceRules: () => permissionRoutes.spaceRules("space-1"),
    rule: () => permissionRoutes.rule("rule-1")
  }),
  relayRoutes: table(relayRoutes, {
    device: () => relayRoutes.device("abcdefghijklmnopqrstuv")
  }),
  runRoutes: table(runRoutes, {
    homeEvidence: () => runRoutes.homeEvidence({ since: "2026-01-01T00:00:00.000Z" }),
    taskAttempts: () => runRoutes.taskAttempts(itemId),
    questions: () => runRoutes.questions(),
    answerQuestion: () => runRoutes.answerQuestion("question-1"),
    progress: () => runRoutes.progress("run-1"),
    detail: () => runRoutes.detail("run-1"),
    events: () => runRoutes.events("run-1"),
    usage: () => runRoutes.usage(),
    sessionUsage: () => runRoutes.sessionUsage(sessionId)
  }),
  sessionRoutes: table(sessionRoutes, {
    list: () => sessionRoutes.list(),
    item: () => sessionRoutes.item(sessionId),
    branch: () => sessionRoutes.branch(sessionId),
    model: () => sessionRoutes.model(sessionId),
    moveToSpace: () => sessionRoutes.moveToSpace(sessionId),
    export: () => sessionRoutes.export(sessionId, "markdown"),
    find: () => sessionRoutes.find(sessionId, "deploy"),
    search: () => sessionRoutes.search("deploy"),
    restore: () => sessionRoutes.restore(sessionId),
    continueRun: () => sessionRoutes.continueRun(sessionId),
    triage: () => sessionRoutes.triage(sessionId),
    archive: () => sessionRoutes.archive(sessionId, { stop: true }),
    permanentDelete: () => sessionRoutes.permanentDelete(sessionId, { stop: false })
  }),
  answerBlockRoutes: table(answerBlockRoutes, {
    states: () => answerBlockRoutes.states(sessionId),
    block: () => answerBlockRoutes.block(sessionId, "message-1", 0)
  }),
  focusChoiceRoutes: table(focusChoiceRoutes, {
    item: () => focusChoiceRoutes.item(spaceId, "question-1"),
    resolve: () => focusChoiceRoutes.resolve(spaceId, "question-1")
  }),
  processRoutes: table(processRoutes, { output: () => processRoutes.output("process-1") }),
  terminalRoutes: table(terminalRoutes, {
    list: () => terminalRoutes.list(sessionId),
    item: () => terminalRoutes.item(sessionId, 1),
    stop: () => terminalRoutes.item(sessionId, 1, "/stop"),
    input: () => terminalRoutes.item(sessionId, 1, "/input"),
    output: () => terminalRoutes.output(sessionId, 1, 0)
  }),
  todoRoutes: table(todoRoutes, {
    item: () => todoRoutes.item(sessionId),
    override: () => todoRoutes.override(sessionId)
  }),
  intelligenceSettingsRoutes: table(intelligenceSettingsRoutes, {}),
  limitSettingsRoutes: table(limitSettingsRoutes, {}),
  skillRoutes: table(skillRoutes, {
    marketplaceSearch: () => skillRoutes.marketplaceSearch("notes"),
    recipe: () => skillRoutes.recipe("recipe-1"),
    item: () => skillRoutes.item("skill-1"),
    content: () => skillRoutes.content("skill-1")
  }),
  storageRoutes: table(storageRoutes, {}),
  toolRoutes: table(toolRoutes, {}),
  wikiRoutes: table(wikiRoutes, {
    pages: () => wikiRoutes.pages(),
    page: () => wikiRoutes.page("page-1"),
    archive: () => wikiRoutes.archive("page-1"),
    restoreArchived: () => wikiRoutes.restoreArchived("page-1"),
    history: () => wikiRoutes.history("page-1"),
    historyRestore: () => wikiRoutes.historyRestore("page-1", "commit-1"),
    diff: () => wikiRoutes.diff("page-1"),
    versionDiff: () => wikiRoutes.versionDiff("page-1", { before: "absent", after: "version-1" }),
    links: () => wikiRoutes.links("page-1"),
    renameDecision: () => wikiRoutes.renameDecision("approval-1", "accept")
  }),
  scriptRoutes: table(scriptRoutes, {
    item: () => scriptRoutes.item(workflowTarget),
    retry: () => scriptRoutes.retry(workflowTarget),
    cancel: () => scriptRoutes.cancel(workflowTarget)
  })
}

const endpointPatterns = (): ReadonlyArray<RegExp> => {
  const patterns: Array<RegExp> = []
  HttpApi.reflect(ArdenApi, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => {
      const source = endpoint.path
        .split("/")
        .map((segment) =>
          segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        )
        .join("/")
      patterns.push(new RegExp(`^${source}$`))
    }
  })
  return patterns
}

const exportedRouteObjects = async (): Promise<ReadonlyArray<string>> => {
  const srcDir = new URL("../../../libs/protocol/src/", import.meta.url)
  const entries = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith("/index.ts"))
    .map((file) => `@arden-hq/protocol/${file.slice(0, -"/index.ts".length)}`)
  const modules: ReadonlyArray<Record<string, unknown>> = await Promise.all(
    entries.map((entry) => import(entry))
  )
  return modules
    .flatMap((module) => Object.keys(module).filter((name) => name.endsWith("Routes")))
    .sort()
}

it("samples every protocol route object", async () => {
  expect(Object.keys(tables).sort()).toEqual(await exportedRouteObjects())
})

it("matches every protocol route to an ArdenApi endpoint path", () => {
  const patterns = endpointPatterns()
  const unmatched = Object.entries(tables).flatMap(([routes, { paths }]) =>
    paths
      .filter(([, path]) => !patterns.some((pattern) => pattern.test(path.split("?")[0] ?? path)))
      .map(([name, path]) => `${routes}.${name} → ${path}`)
  )
  expect(unmatched).toEqual([])
})
