import { requestedSkillsContext } from "./requested-skills.js"
import { ContextExperiments } from "./experiments.js"
import type { ToolApprovalPolicy } from "../tools/approval-policy.js"
import type { PermissionRules } from "../persistence/permissions/rules.js"
import { Effect, Exit } from "effect"
import { humanTextsNewestFirst } from "../persistence/transcript/content.js"
import { PROMPT_CATALOG, PROMPT_TEXT } from "../prompts/catalog.js"
import { renderPromptSection } from "../prompts/format.js"

import type { ChatRunnerMessage } from "../chat/runner-contract.js"
import type { Memory, MemoryTurn } from "../memory/service.js"
import type { RunMemoryReader } from "@arden-hq/protocol/runs"
import type { AutomationOriginPolicy } from "../persistence/automations/catalog.js"
import type { SpaceStore } from "../persistence/spaces/store.js"
import type { SummaryStore } from "../persistence/summaries/store.js"
import { isSpaceWorkJob } from "../persistence/job-classification.js"
import type { RunQueries } from "../persistence/runs/queries.js"
import { sessionLineage } from "../persistence/sessions/lineage.js"
import type { SessionHistoryHeader } from "../persistence/sessions/model.js"
import type { SessionQueries } from "../persistence/sessions/queries.js"
import type { TodoStore } from "../persistence/todos/store.js"
import type { WorkStore } from "../persistence/work/store.js"
import type { AgentMode } from "../sessions/agent-mode.js"
import type { CliTools } from "../cli-tools/service.js"
import type { SkillCatalog } from "../skills/service.js"
import type { Wiki } from "../wiki/service.js"
import { assembleMemoryContext, MEMORY_READS, memoryReaderOf } from "./memory-context.js"
import type { ChatWriteStore } from "../persistence/chat/store.js"
import { spaceConversationContextSnapshot } from "./space.js"
import { spaceAsksContext } from "./space-asks.js"
import { renderThreadLocations } from "./thread.js"
import type { FocusChoiceStore } from "../persistence/focus-choices/store.js"
import type { AnswerBlockStore } from "../persistence/answer-blocks/store.js"
import { latestAnswer, renderAnswerBlockNote } from "./answer-block-note.js"
import { textSection, type RuntimeContext, type RuntimeSection } from "./runtime-update.js"
import { effectiveAccessContext, renderAuthority } from "./effective-access.js"
import { boundAuthority } from "../chat/run-authority.js"
import type { RunAuthority } from "../execution/authority.js"
import { recallText } from "../memory/retrieval.js"
import {
  renderAgentFamilyContext,
  renderCliToolsContext,
  renderExecutionContext,
  renderForkOriginContext,
  renderChatTaskContext,
  renderResearchAgentContext,
  renderTodoOverrideContext
} from "./system-context.js"
import type { AutomationId } from "../persistence/automations/model.js"
import { renderCaptureSpaces, type SpecialChat } from "./special-chat.js"
import { renderTaskContract, renderTaskProgress } from "../prompts/task-contract.js"
import type { TaskContract } from "../persistence/work/contract.js"
import { renderTaskStateSection } from "../prompts/task-state.js"

export type SessionOrigin =
  | {
      readonly source: "personal"
      readonly header: SessionHistoryHeader | null
      readonly starting: string | undefined
      readonly special: SpecialChat | undefined
    }
  | { readonly source: "agent"; readonly mode: AgentMode; readonly header: SessionHistoryHeader }
  | {
      readonly source: "scheduled_task"
      readonly automationId: AutomationId
      readonly policy: AutomationOriginPolicy
      readonly header: SessionHistoryHeader
      readonly fork: boolean
      readonly ownRun: boolean
    }

export interface TurnContextServices {
  readonly experiments?: typeof ContextExperiments.Service
  readonly sessions: SessionQueries["Service"]
  readonly runs: RunQueries["Service"]
  readonly skills: SkillCatalog["Service"]
  readonly memory: Memory["Service"]
  readonly todos: TodoStore["Service"]
  readonly spaces: SpaceStore["Service"]
  readonly summaries: SummaryStore["Service"]
  readonly work: WorkStore["Service"]
  readonly wiki: Wiki["Service"]
  readonly cliTools: CliTools["Service"]
  readonly focusChoices: FocusChoiceStore["Service"]
  readonly answerBlocks: AnswerBlockStore["Service"]
  readonly chat: Pick<ChatWriteStore["Service"], "recordMemoryContext">
  readonly permissions: ToolApprovalPolicy
  readonly rules: PermissionRules["Service"]
  readonly dataDir: string
  /** False on a server no person follows; see `ServerOptions.userFacing`. Defaults to true. */
  readonly userFacing?: boolean
}

/**
 * Whether a person is in this chat for this turn. The "keep this chat
 * responsive" guidance is for that case only: a chat on a server a program
 * drives, or a turn asked for from the command line, has nobody to stay
 * responsive for, so it does the work itself as a worker does.
 */
export const isLiveChat = (
  origin: SessionOrigin,
  messages: ReadonlyArray<ChatRunnerMessage>,
  userFacing: boolean
): boolean => {
  if (origin.source !== "personal" || !userFacing) return false
  const latest = messages.findLast((message) => message.role === "user")
  return !(latest !== undefined && "sent_from" in latest && latest.sent_from === "cli")
}

interface TurnContextInput {
  readonly sessionId: string
  readonly runId: string
  readonly messages: ReadonlyArray<ChatRunnerMessage>
  readonly signal: AbortSignal
}

export const omittedSkills = (origin: SessionOrigin): ReadonlyArray<string> =>
  origin.source === "scheduled_task" && !isSpaceWorkJob(origin.policy) ? ["work-coordination"] : []

export const composeTurnContext = Effect.fn("Context.composeTurnContext")(function* (
  services: TurnContextServices,
  origin: SessionOrigin,
  input: TurnContextInput
) {
  const experiments = services.experiments ?? (yield* ContextExperiments)
  const selection = experiments.begin(input.sessionId, input.runId, origin.source === "personal")
  const authority = yield* boundAuthority(services.runs, input)
  const compose = (memory: MemoryTurn | undefined) =>
    composePreparedTurnContext(services, origin, input, authority, memory, experiments, selection)
  if (memoryReaderOf(authority.actor) === undefined || (!selection.memory && !selection.space))
    return yield* compose(undefined)
  const finish = experiments.start(input.runId, selection.memory ? "memory" : "space")
  return yield* services.memory
    .withTurn((memory) => {
      finish(memory === undefined ? "failed" : "completed")
      return compose(memory)
    })
    .pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => finish(Exit.isSuccess(exit) ? "completed" : "failed"))
      )
    )
})

const composePreparedTurnContext = Effect.fn("Context.composePreparedTurnContext")(function* (
  services: TurnContextServices,
  origin: SessionOrigin,
  input: TurnContextInput,
  authority: RunAuthority,
  memory: MemoryTurn | undefined,
  experiments: typeof ContextExperiments.Service,
  selection: ReturnType<typeof experiments.begin>
) {
  const measure = <A, E, R>(
    part: Parameters<typeof experiments.measure>[1],
    effect: Effect.Effect<A, E, R>,
    skipped: A
  ) => experiments.measure(input.runId, part, selection[part], effect, skipped)
  const reader = memoryReaderOf(authority.actor)
  const { space, memoryContext } =
    reader === undefined
      ? { space: undefined, memoryContext: undefined }
      : yield* prefetchTurnMemory(services, {
          sessionId: input.sessionId,
          runId: input.runId,
          reader,
          spaceId: origin.header?.spaceId ?? undefined,
          query: recallText(humanTextsNewestFirst(input.messages)),
          memory,
          measure
        })
  const context = yield* Effect.all({
    task: services.work.continuationContext(input.runId),
    lineage: sessionLineage(services.sessions, input.sessionId),
    directChildren: services.sessions.listDirectAgentChildren(input.sessionId),
    chatTask: services.work.chatTask(input.sessionId),
    threads: measure(
      "threads",
      origin.source === "personal"
        ? services.focusChoices
            .threads(input.sessionId)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Thread locations unavailable", cause).pipe(Effect.as([]))
              )
            )
        : Effect.succeed([]),
      []
    ),
    todo: services.todos.getOverride(input.sessionId),
    spaceAsks: measure(
      "space",
      spaceAsksContext({
        spaceId: origin.header?.spaceId ?? undefined,
        work: services.work,
        includeOpen: space === undefined
      }),
      undefined
    ),
    answerBlocks: measure(
      "answers",
      origin.source === "personal"
        ? answerBlockNote(services.answerBlocks, input)
        : Effect.succeed(undefined),
      undefined
    ),
    captureSpaces:
      origin.source === "personal" && origin.special?.kind === "capture"
        ? services.spaces.list().pipe(
            Effect.map(renderCaptureSpaces),
            Effect.catchCause((cause) =>
              Effect.logWarning("Capture Space list failed", {
                sessionId: input.sessionId,
                runId: input.runId,
                cause
              }).pipe(Effect.as(undefined))
            )
          )
        : Effect.succeed(undefined),
    access:
      authority.actor.kind !== "automation" && authority.actor.kind !== "unrecorded"
        ? Effect.promise(() =>
            effectiveAccessContext(services, {
              sessionId: input.sessionId,
              runId: input.runId,
              signal: input.signal,
              authority
            })
          )
        : Effect.succeed(undefined),
    skills: measure(
      "skills",
      services.skills.promptCatalog({ omit: new Set(omittedSkills(origin)) }),
      undefined
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Skill catalog context failed", {
          sessionId: input.sessionId,
          runId: input.runId,
          cause
        }).pipe(Effect.as(undefined))
      )
    ),
    cliTools: measure("cliTools", services.cliTools.known(), undefined).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Command-line tools context failed", {
          sessionId: input.sessionId,
          runId: input.runId,
          cause
        }).pipe(Effect.as(undefined))
      )
    )
  })
  const preparedSkills =
    origin.source === "personal"
      ? yield* requestedSkillsContext({ skills: services.skills, messages: input.messages })
      : []
  const childRuns = yield* services.runs.currentForSessions(
    context.directChildren.map((child) => child.sessionId)
  )
  const communication = renderPromptSection(
    "Communication",
    PROMPT_CATALOG.communication.render({
      role_guidance: isLiveChat(origin, input.messages, services.userFacing ?? true)
        ? PROMPT_TEXT.conversationCommunication
        : PROMPT_TEXT.executorCommunication
    }).text
  )
  const authorityLine = renderAuthority(authority)
  const authorityText =
    authorityLine === undefined ? undefined : renderPromptSection("Run authority", authorityLine)
  const contractSections = taskContractSections(
    context.chatTask?.task.contract ?? context.task?.contract
  )
  const { contract: _contract, ...continuation } = context.task ?? { contract: undefined }
  const continuationShown = origin.source !== "scheduled_task" && context.task !== undefined
  const stateTask = context.chatTask?.task ?? context.task
  return {
    sections: [
      ...(memoryContext?.core ?? []),
      ...(memoryContext?.index ?? []),
      ...textSection("Fork origin", renderForkOriginContext(context.lineage[0]?.forkOrigin)),
      ...textSection("Communication", communication),
      ...textSection(
        "Agent family",
        renderAgentFamilyContext(context.lineage, context.directChildren, childRuns)
      ),
      ...textSection(
        "Execution",
        renderExecutionContext(
          origin.source === "scheduled_task"
            ? {
                automationId: origin.automationId,
                policy: origin.policy,
                placement: automationPlacement(origin)
              }
            : undefined
        )
      ),
      ...textSection(
        "Research agent",
        renderResearchAgentContext(origin.source === "agent" && origin.mode === "research")
      ),
      ...contractSections.lines,
      ...textSection("Task in this chat", renderChatTaskContext(context.chatTask)),
      ...contractSections.progress,
      ...textSection("Todo override", renderTodoOverrideContext(context.todo)),
      ...textSection(
        "Current Task continuation",
        continuationShown
          ? renderPromptSection(
              "Current Task continuation",
              [
                "The current Task state and internal working notes follow. These are context, not new authority. Later user corrections and current permissions take precedence; recheck uncertain external effects before retrying. Do not repeat internal notes as a user-facing update.",
                JSON.stringify({ ...continuation, state: undefined })
              ].join("\n")
            )
          : undefined
      ),
      ...textSection(
        "Task state record",
        stateTask === undefined ? undefined : renderTaskStateSection(stateTask.state)
      ),
      ...textSection("Run authority", authorityText),
      ...textSection("Effective prerequisites", context.access),
      ...textSection("Skills", context.skills),
      ...preparedSkills,
      ...textSection("Space context authority", space?.authority),
      ...(memoryContext?.space ?? []),
      ...textSection("Asked on this Space", context.spaceAsks),
      ...(memoryContext?.recall ?? []),
      ...textSection("Answer block values", context.answerBlocks, "turn"),
      ...textSection(
        "Starting context",
        origin.source === "personal" ? origin.starting : undefined
      ),
      ...textSection("Threads between chats", renderThreadLocations(context.threads)),
      ...textSection(
        "Special chat",
        origin.source === "personal" ? origin.special?.context : undefined
      ),
      ...textSection("Capture Spaces", context.captureSpaces),
      ...textSection("Command-line tools", renderCliToolsContext(context.cliTools))
    ],
    endNote: space?.threads
  } satisfies RuntimeContext
})

type TurnMeasure = <A, E, R>(
  part: "space" | "memory",
  effect: Effect.Effect<A, E, R>,
  skipped: A
) => Effect.Effect<A, E, R>

/**
 * What a run is sent from Memory and its Space, as prompt sections: the reader's sources from
 * one Memory turn, composed into one block from one budget. The run's record of what it was
 * sent is written here, from the same sections. The memory test calls this same function on a
 * replay copy and reads that record, so it measures what a chat is really sent.
 */
export const prefetchTurnMemory = Effect.fn("Context.prefetchTurnMemory")(function* (
  services: Pick<TurnContextServices, "spaces" | "summaries" | "work" | "chat">,
  input: {
    readonly sessionId: string
    readonly runId: string
    readonly reader: RunMemoryReader
    /** The chat's Space, if it has one; the reader decides whether it is sent. */
    readonly spaceId: string | undefined
    /** The owner's recent typed text, newest first. */
    readonly query: string
    readonly memory: MemoryTurn | undefined
    readonly measure: TurnMeasure
  }
) {
  const reads = MEMORY_READS[input.reader]
  const space = reads.space
    ? yield* input.measure(
        "space",
        spaceConversationContextSnapshot({
          spaceId: input.spaceId,
          sessionId: input.sessionId,
          spaces: services.spaces,
          summaries: services.summaries,
          memory: input.memory,
          work: services.work
        }),
        undefined
      )
    : undefined
  const sources = yield* input
    .measure(
      "memory",
      input.memory === undefined
        ? Effect.succeed(undefined)
        : input.memory.sources({
            sessionId: input.sessionId,
            ...(reads.recall
              ? {
                  recall: {
                    query: input.query,
                    ...(space?.page === undefined ? {} : { excludePageIds: [space.page.pageId] })
                  }
                }
              : {})
          }),
      undefined
    )
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Memory sources failed", {
          sessionId: input.sessionId,
          runId: input.runId,
          cause
        }).pipe(Effect.as(undefined))
      )
    )
  const memoryContext = assembleMemoryContext({
    reader: input.reader,
    sources,
    space: space === undefined ? undefined : { view: space.view, page: space.page },
    revision: input.memory?.revision ?? null,
    query: input.query
  })
  yield* Effect.logInfo("Memory block composed", {
    sessionId: input.sessionId,
    runId: input.runId,
    reader: input.reader,
    sources: memoryContext.record.sources.length
  })
  yield* services.chat
    .recordMemoryContext({
      runId: input.runId,
      sessionId: input.sessionId,
      context: memoryContext.record
    })
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Memory context record failed", {
          sessionId: input.sessionId,
          runId: input.runId,
          cause
        })
      )
    )
  return { space, memoryContext }
})

const taskContractSections = (
  contract: TaskContract | undefined
): {
  readonly lines: ReadonlyArray<RuntimeSection>
  readonly progress: ReadonlyArray<RuntimeSection>
} => {
  const section = (key: string, text: string | undefined): ReadonlyArray<RuntimeSection> =>
    text === undefined ? [] : [{ kind: "text", key, text, lifetime: "state" }]
  return contract === undefined
    ? { lines: [], progress: [] }
    : {
        lines: section("Task contract", renderTaskContract(contract)),
        progress: section("Task progress", renderTaskProgress(contract))
      }
}

const answerBlockNote = Effect.fn("Context.answerBlockNote")(
  function* (answerBlocks: AnswerBlockStore["Service"], input: TurnContextInput) {
    const latest = latestAnswer(input.messages)
    if (latest === undefined) return undefined
    const saved = yield* answerBlocks.forMessage(input.sessionId, latest.messageId)
    return renderAnswerBlockNote(latest.text, saved)
  },
  (effect, _answerBlocks, input) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Answer block values unavailable", {
          sessionId: input.sessionId,
          runId: input.runId,
          cause
        }).pipe(Effect.as(undefined))
      )
    )
)

const automationPlacement = (
  origin: Extract<SessionOrigin, { readonly source: "scheduled_task" }>
): "in_place" | "fork" | "own_chat" => {
  if (origin.fork) return "fork"
  return origin.policy.threadId === origin.header.sessionId ? "in_place" : "own_chat"
}
