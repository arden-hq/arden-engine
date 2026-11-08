import { ContextExperiments } from "../../context/experiments.js"
import { makeToolApprovalPolicy } from "../../tools/approval-policy.js"
import { ApprovalPolicyStore } from "../../persistence/permissions/approval-policy.js"
import { PermissionRules } from "../../persistence/permissions/rules.js"
import { DataRoot } from "../../runtime/data-root.js"
import type { ModelRoute } from "../../models/provider.js"
import { chatOutputOptions } from "../../models/structured-output.js"
import type { StopReason } from "@arden-hq/loop"
import { Effect } from "effect"

import { systemHandlerForAutomation } from "../../automations/system.js"
import { loadLocalInstructions } from "../../context/local-instructions.js"
import { ContextCompaction, type ContextCompactionError } from "../../context/service.js"
import { renderLocalTimeContext } from "../../context/system-context.js"
import {
  composeTurnContext,
  omittedSkills,
  type SessionOrigin,
  type TurnContextServices
} from "../../context/turn-context.js"
import { readSpecialChat } from "../../context/special-chat.js"
import { renderTodoReminder } from "../../context/todo-reminder.js"
import { renderThreadContext } from "../../context/thread.js"
import {
  chatSystemPrompt,
  GlobalInstructions,
  globalInstructionManifest,
  loadForRun
} from "../../context/global-instructions.js"
import { runPolicyOf } from "../../execution/policy.js"
import { authorityScopes } from "../../execution/authority.js"
import { boundAuthority } from "../run-authority.js"
import { Memory } from "../../memory/service.js"
import { SPACE_CHAT_PRELOAD, SPECIAL_CHAT_PRELOAD } from "../../tools/tool-catalog.js"
import { AutomationCatalog } from "../../persistence/automations/catalog.js"
import { AutomationQueue } from "../../persistence/automations/queue.js"
import { eventTextTools } from "../../persistence/automations/event-text.js"
import { ChatWriteStore } from "../../persistence/chat/store.js"
import { SpaceStore } from "../../persistence/spaces/store.js"
import { SummaryStore } from "../../persistence/summaries/store.js"
import { RunQueries } from "../../persistence/runs/queries.js"
import { SessionQueries } from "../../persistence/sessions/queries.js"
import { IntelligenceSettingsStore } from "../../persistence/settings/store.js"
import { TodoStore } from "../../persistence/todos/store.js"
import { FocusChoiceStore } from "../../persistence/focus-choices/store.js"
import { AnswerBlockStore } from "../../persistence/answer-blocks/store.js"
import { WorkStore } from "../../persistence/work/store.js"
import { readAgentSessionMetadata } from "../../sessions/agent-mode.js"
import { CliTools } from "../../cli-tools/service.js"
import { SkillCatalog } from "../../skills/service.js"
import {
  policyPathOptions,
  resolveLocalPath,
  sessionPathPolicy
} from "../../storage/local-paths.js"
import { ServerToolRegistry } from "../../tools/registry.js"
import { Wiki } from "../../wiki/service.js"
import { makeLoopChatRunner, type LoopChatCompactionResult } from "../loop-runner.js"
import type { ChatRunner } from "../runner-contract.js"
import type { StoredMessageDecodeError } from "../message-errors.js"
import { toChatRunnerMessages } from "../run-driver.js"
import type { AutomationId } from "../../persistence/automations/model.js"

const MAX_RUN_STEPS = 200

const stoppedEarly = (reason: StopReason): string => {
  switch (reason) {
    case "cancelled":
    case "end_turn":
    case "paused":
      return ""
    case "max_iterations":
      return `Stopped at the ${MAX_RUN_STEPS}-step limit before a final reply. The work so far is in this chat. Send it a message to continue.`
    case "no_progress":
      return "Stopped after repeated failed steps, before a final reply."
    case "max_tool_calls":
    case "max_wall_time":
    case "max_cost":
    case "max_token_budget":
    case "max_output_length":
      return "Stopped at a run limit before a final reply. The work so far is in this chat."
  }
}

export const makeBuiltInChatRunners = Effect.fn("Chat.builtInRunners")(function* () {
  const experiments = yield* ContextExperiments
  const services: TurnContextServices = {
    sessions: yield* SessionQueries,
    runs: yield* RunQueries,
    skills: yield* SkillCatalog,
    memory: yield* Memory,
    todos: yield* TodoStore,
    spaces: yield* SpaceStore,
    summaries: yield* SummaryStore,
    work: yield* WorkStore,
    wiki: yield* Wiki,
    cliTools: yield* CliTools,
    experiments,
    focusChoices: yield* FocusChoiceStore,
    answerBlocks: yield* AnswerBlockStore,
    permissions: makeToolApprovalPolicy({
      policy: yield* ApprovalPolicyStore,
      rules: yield* PermissionRules
    }),
    rules: yield* PermissionRules,
    dataDir: (yield* DataRoot).dir
  }
  const registry = yield* ServerToolRegistry
  const compaction = yield* ContextCompaction
  const chat = yield* ChatWriteStore
  const automations = yield* AutomationCatalog
  const automationQueue = yield* AutomationQueue
  const globalInstructions = yield* GlobalInstructions
  const settingsStore = yield* IntelligenceSettingsStore
  const readAssistantName = (): Promise<string> =>
    Effect.runPromise(
      settingsStore.settings().pipe(Effect.map((current): string => current.assistantName))
    )
  const sessionOrigin = (sessionId: string, runAutomationId: AutomationId | null) =>
    services.sessions.loadHeaderSnapshot(sessionId).pipe(
      Effect.flatMap((snapshot) => {
        if (snapshot === null) {
          return Effect.succeed<SessionOrigin>({
            source: "personal",
            header: null,
            starting: undefined,
            special: undefined
          })
        }
        const header = snapshot.header
        if (header.sessionType === "agent") {
          const agent = readAgentSessionMetadata(snapshot.metadata)
          if (agent === null) {
            return Effect.fail(new Error("Agent Session metadata is invalid"))
          }
          return Effect.succeed<SessionOrigin>({ source: "agent", mode: agent.mode, header })
        }
        const automationId = runAutomationId ?? header.originAutomationId
        return automationId === null
          ? Effect.succeed<SessionOrigin>({
              source: "personal",
              header,
              starting: renderThreadContext(snapshot.metadata["thread"]),
              special: readSpecialChat(snapshot.metadata)
            })
          : automations.originPolicy(automationId).pipe(
              Effect.map((policy): SessionOrigin => ({
                source: "scheduled_task",
                automationId,
                policy,
                header,
                fork:
                  snapshot.metadata["fork_origin"] !== undefined ||
                  snapshot.metadata["fork_of"] !== undefined,
                ownRun: runAutomationId !== null
              }))
            )
      })
    )
  return (route: ModelRoute): ChatRunner =>
    makeLoopChatRunner({
      provider: route.provider,
      onRequestComplete: (input) =>
        compaction.rememberRequest({ ...input, provider: route.provider }),
      output: async (input) =>
        input.outputSchema === null
          ? undefined
          : chatOutputOptions(input.outputSchema, route.structuredOutputDialect),
      systemPrompt: async () => {
        const [assistantName, current] = await Promise.all([
          readAssistantName(),
          Effect.runPromise(loadForRun(globalInstructions))
        ])
        return chatSystemPrompt(assistantName, globalInstructions.file, current)
      },
      localInstructions: async ({ sessionId, runId, signal, target, targetKind }) => {
        const policy = await sessionPathPolicy(services, { sessionId, runId, signal })
        if (target === undefined) return loadLocalInstructions({ policy })
        const resolved = await resolveLocalPath(target, policy.cwd, {
          allowMissing: targetKind === "file",
          ...policyPathOptions(policy)
        }).catch(() => undefined)
        return resolved === undefined
          ? undefined
          : loadLocalInstructions({
              policy,
              target: resolved,
              ...(targetKind === undefined ? {} : { targetKind })
            })
      },
      recordLocalInstructions: ({ runId, sources }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const load = yield* loadForRun(globalInstructions)
            yield* chat.recordLocalInstructions({
              runId,
              sources: [...globalInstructionManifest(globalInstructions.file, load), ...sources]
            })
          })
        ),
      toolset: (run) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const policy = yield* services.runs.get(run.runId).pipe(Effect.flatMap(runPolicyOf))
            const origin = yield* sessionOrigin(run.sessionId, run.automationId)
            experiments.begin(run.sessionId, run.runId, origin.source === "personal")
            const authority = yield* boundAuthority(services.runs, run)
            const scoped = yield* registry.runToolset(
              { ...run, policy, authority },
              {
                omitSkills: omittedSkills(origin),
                declareTree:
                  origin.source === "agent" ||
                  (origin.source === "personal" && policy.execution.mode === "inline") ||
                  (origin.source === "scheduled_task" && origin.fork)
              }
            )
            if (origin.source === "scheduled_task" && origin.fork) return scoped
            return systemHandlerForAutomation(run.automationId)?.tools?.(scoped) ?? scoped
          })
        ),
      preloadTools: ({ sessionId, runId, automationId }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const origin = yield* sessionOrigin(sessionId, automationId)
            if (origin.source === "scheduled_task" && origin.fork) {
              const [primary] = authorityScopes(
                yield* boundAuthority(services.runs, { runId, sessionId })
              )
              return registry.ownedTools([primary])
            }
            if (origin.source === "agent")
              return registry.ownedTools(
                authorityScopes(yield* boundAuthority(services.runs, { runId, sessionId }))
              )
            if (origin.source === "personal" && origin.special !== undefined)
              return SPECIAL_CHAT_PRELOAD[origin.special.kind]
            const base = typeof origin.header?.spaceId === "string" ? SPACE_CHAT_PRELOAD : []
            if (origin.source !== "scheduled_task") return base
            const carried = yield* automationQueue
              .runEvents({ sessionId, chatRunId: runId })
              .pipe(Effect.orElseSucceed(() => undefined))
            const followUps = carried?.run === "this_run" ? eventTextTools(carried.events) : []
            return [...new Set([...base, ...followUps])]
          })
        ),
      config: {
        maxIterations: MAX_RUN_STEPS,
        policy: {
          fallbackResultText: (_messages, reason) => stoppedEarly(reason)
        }
      },
      localTime: renderLocalTimeContext,
      todoReminder: ({ sessionId, signal }) =>
        Effect.runPromise(
          services.todos.get(sessionId).pipe(
            Effect.map(renderTodoReminder),
            Effect.catchCause((cause) =>
              Effect.logWarning("Todo reminder unavailable", { sessionId, cause }).pipe(
                Effect.as(undefined)
              )
            )
          ),
          { signal }
        ),
      systemContext: (input) =>
        Effect.runPromise(
          sessionOrigin(input.sessionId, input.automationId).pipe(
            Effect.flatMap((origin) => composeTurnContext(services, origin, input))
          )
        ),
      onOrphanToolOutputs: ({ sessionId, runId, orphans }) =>
        Effect.runFork(
          Effect.logWarning("Sent orphaned tool outputs as context notes", {
            sessionId,
            runId,
            orphans
          })
        ),
      compact: (input) =>
        Effect.runPromise(
          compaction
            .automatic({
              sessionId: input.sessionId,
              runId: input.runId,
              inputTokens: input.inputTokens,
              pendingCallIds: input.pendingCallIds,
              signal: input.signal
            })
            .pipe(
              Effect.flatMap(
                (messages): Effect.Effect<LoopChatCompactionResult, StoredMessageDecodeError> =>
                  messages === null
                    ? Effect.succeed({ kind: "unchanged" as const })
                    : toChatRunnerMessages(input.sessionId, messages).pipe(
                        Effect.map((replacement) => ({
                          kind: "replacement" as const,
                          messages: replacement
                        }))
                      )
              ),
              Effect.catchTag(
                "ContextCompactionError",
                (cause): Effect.Effect<LoopChatCompactionResult, ContextCompactionError> => {
                  if (input.signal.aborted) return Effect.fail(cause)
                  if (cause.reason === "conflict" || cause.reason === "not_found") {
                    return Effect.succeed({ kind: "unchanged" as const })
                  }
                  if (cause.reason === "unavailable") {
                    return Effect.logDebug("Automatic context compaction unavailable", cause).pipe(
                      Effect.as({ kind: "unchanged" as const })
                    )
                  }
                  if (cause.reason === "provider") {
                    return Effect.logWarning("Automatic context compaction failed", cause).pipe(
                      Effect.as({ kind: "disabled_for_run" as const })
                    )
                  }
                  return Effect.fail(cause)
                }
              )
            )
        )
    })
})
