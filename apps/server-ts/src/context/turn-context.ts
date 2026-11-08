import { requestedSkillsContext } from "./requested-skills.js"
import { ContextExperiments } from "./experiments.js"
import type { ToolApprovalPolicy } from "../tools/approval-policy.js"
import type { PermissionRules } from "../persistence/permissions/rules.js"
import { Effect, Exit } from "effect"
import { latestHumanText } from "../persistence/transcript/content.js"
import { PROMPT_CATALOG, PROMPT_TEXT } from "../prompts/catalog.js"
import { renderPromptSection } from "../prompts/format.js"

import type { ChatRunnerMessage } from "../chat/runner-contract.js"
import type { Memory, MemoryTurn } from "../memory/service.js"
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
import {
  budgetContinuityContext,
  LIVE_CONTINUITY_CONTEXT_MAX_BYTES,
  type ContinuityContextSource
} from "./continuity-budget.js"
import { spaceConversationContextSnapshot } from "./space.js"
import { spaceAsksContext } from "./space-asks.js"
import { renderThreadLocations } from "./thread.js"
import type { FocusChoiceStore } from "../persistence/focus-choices/store.js"
import type { AnswerBlockStore } from "../persistence/answer-blocks/store.js"
import { latestAnswer, renderAnswerBlockNote } from "./answer-block-note.js"
import { renderSpaceContext } from "./space-render.js"
import type { RuntimeContext, RuntimeSection } from "./runtime-update.js"
import { effectiveAccessContext, renderAuthority } from "./effective-access.js"
import { boundAuthority } from "../chat/run-authority.js"
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
  readonly permissions: ToolApprovalPolicy
  readonly rules: PermissionRules["Service"]
  readonly dataDir: string
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
  const compose = (memory: MemoryTurn | undefined) =>
    composePreparedTurnContext(services, origin, input, memory, experiments, selection)
  if (origin.source !== "personal" || (!selection.memory && !selection.space))
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
  memory: MemoryTurn | undefined,
  experiments: typeof ContextExperiments.Service,
  selection: ReturnType<typeof experiments.begin>
) {
  const measure = <A, E, R>(
    part: Parameters<typeof experiments.measure>[1],
    effect: Effect.Effect<A, E, R>,
    skipped: A
  ) => experiments.measure(input.runId, part, selection[part], effect, skipped)
  const space = yield* measure(
    "space",
    origin.source === "personal"
      ? spaceConversationContextSnapshot({
          spaceId: origin.header?.spaceId ?? undefined,
          sessionId: input.sessionId,
          spaces: services.spaces,
          summaries: services.summaries,
          memory,
          work: services.work
        })
      : Effect.succeed(undefined),
    undefined
  )
  const spaceRender = space === undefined ? undefined : renderSpaceContext(space.view)
  const spaceText = spaceRender?.text
  const deliveredPageId =
    space?.pageId !== undefined && spaceRender?.pageWhole === true ? space.pageId : undefined
  const authority = yield* boundAuthority(services.runs, input)
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
    ),
    memory: measure(
      "memory",
      memory === undefined
        ? Effect.succeed(undefined)
        : memory.recall({
            sessionId: input.sessionId,
            query: latestHumanText(input.messages) ?? "",
            ...(deliveredPageId === undefined ? {} : { excludePageIds: [deliveredPageId] })
          }),
      undefined
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Memory recall failed", {
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
      role_guidance:
        origin.source === "personal"
          ? PROMPT_TEXT.conversationCommunication
          : PROMPT_TEXT.executorCommunication
    }).text
  )
  const continuitySources: Array<ContinuityContextSource> = []
  if (spaceText !== undefined)
    continuitySources.push({
      identity: `space:${origin.header?.spaceId ?? "unknown"}`,
      kind: "session",
      content: spaceText,
      priority: 100
    })
  if (context.memory?.text !== null && context.memory?.text !== undefined) {
    continuitySources.push({
      identity: `recall:${context.memory.revision ?? "none"}:${context.memory.sources
        .map((source) => source.pageId)
        .sort()
        .join(",")}`,
      kind: "recall",
      content: context.memory.text,
      priority: 50
    })
  }
  const continuity = budgetContinuityContext({
    sources: continuitySources,
    maxBytes: LIVE_CONTINUITY_CONTEXT_MAX_BYTES
  })
  yield* Effect.logInfo("Continuity context composed", {
    sessionId: input.sessionId,
    runId: input.runId,
    excludedRecallPages: deliveredPageId === undefined ? 0 : 1,
    ...continuity.telemetry
  })
  const authorityLine = renderAuthority(authority)
  const authorityText =
    authorityLine === undefined ? undefined : renderPromptSection("Run authority", authorityLine)
  const recall = continuity.sources.find((source) => source.kind === "recall")?.content
  const contractSections = taskContractSections(
    context.chatTask?.task.contract ?? context.task?.contract
  )
  const { contract: _contract, ...continuation } = context.task ?? { contract: undefined }
  const continuationShown = origin.source !== "scheduled_task" && context.task !== undefined
  const stateTask = context.chatTask?.task ?? context.task
  const text = (
    name: string,
    value: string | undefined,
    lifetime: "state" | "turn" = "state"
  ): ReadonlyArray<RuntimeSection> => {
    const trimmed = value?.trim()
    if (trimmed === undefined || trimmed === "") return []
    const heading = /^## (.+)/.exec(trimmed)?.[1]?.trim()
    return [{ kind: "text", key: heading ?? name, text: trimmed, lifetime }]
  }
  return {
    sections: [
      ...text("Core Memory", context.memory?.core ?? undefined),
      ...text("Fork origin", renderForkOriginContext(context.lineage[0]?.forkOrigin)),
      ...text("Communication", communication),
      ...text(
        "Agent family",
        renderAgentFamilyContext(context.lineage, context.directChildren, childRuns)
      ),
      ...text(
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
      ...text(
        "Research agent",
        renderResearchAgentContext(origin.source === "agent" && origin.mode === "research")
      ),
      ...contractSections.lines,
      ...text("Task in this chat", renderChatTaskContext(context.chatTask)),
      ...contractSections.progress,
      ...text("Todo override", renderTodoOverrideContext(context.todo)),
      ...text(
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
      ...text(
        "Task state record",
        stateTask === undefined ? undefined : renderTaskStateSection(stateTask.state)
      ),
      ...text("Run authority", authorityText),
      ...text("Effective prerequisites", context.access),
      ...text("Skills", context.skills),
      ...preparedSkills,
      ...text("Space context authority", space?.authority),
      ...(space === undefined || spaceText === undefined
        ? []
        : [{ kind: "space" as const, key: "Current Space", text: spaceText, space: space.view }]),
      ...text("Asked on this Space", context.spaceAsks),
      ...text("Memory recall", recall, "turn"),
      ...text("Answer block values", context.answerBlocks, "turn"),
      ...text("Starting context", origin.source === "personal" ? origin.starting : undefined),
      ...text("Threads between chats", renderThreadLocations(context.threads)),
      ...text("Special chat", origin.source === "personal" ? origin.special?.context : undefined),
      ...text("Capture Spaces", context.captureSpaces),
      ...text("Command-line tools", renderCliToolsContext(context.cliTools))
    ],
    endNote: space?.threads
  } satisfies RuntimeContext
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
