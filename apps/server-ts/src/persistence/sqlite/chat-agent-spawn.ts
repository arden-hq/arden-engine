import { countOf } from "@arden-hq/std/count"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import type { RunContext } from "@arden-hq/protocol/runs"
import type { PersistedChildAgentMetadata } from "@arden-hq/protocol/chat"
import type { ToolResult } from "@arden-hq/loop"
import { DateTime, Effect } from "effect"
import { journalHeadSequenceSql } from "@arden-hq/journal/effect"
import {
  ChatAgentSpawnError,
  ChatWriteError,
  ChatWriteConflictError,
  type ChatWriteStore,
  type ChatWriteSpawnAgentInput,
  type ChatWriteSpawnAgentResult,
  type ChatWriteSpawnAgentFailure
} from "../chat/store.js"
import type { IntelligenceSettingsStore } from "../settings/store.js"
import type { ChatRules } from "../chat/rules.js"
import { JsonObjectSchema } from "../json.js"
import { ToolExecutionStoreError } from "../tools/store.js"
import { StoredMessageEnvelopeSchema, type StoredMessageEnvelope } from "../transcript/model.js"
import {
  agentSessionMetadata,
  readAgentSessionMetadata,
  type AgentMode,
  type NewAgentSessionMetadata
} from "../../sessions/agent-mode.js"
import { friendlySessionRef } from "../public-ref.js"
import { captureChildTask, recordChildAttempt, withCausedBelongsTo } from "./run-context.js"
import { delegateAuthority } from "./run-authority.js"
import { captureRunPolicy, workerScopes } from "./run-policy.js"
import {
  requireRunningToolExecutionInTransaction,
  settleToolExecutionInTransaction
} from "./tool-receipts.js"
import { decodeJson, encodeJson } from "./json.js"
import { writeError, validateInput } from "./chat-write-errors.js"
import {
  runAutomationContextMode,
  runAutomationOrigin,
  runOutputSchema,
  setCheckpoint,
  type RunRow
} from "./chat-run.js"
import { schedulingForSession } from "./chat-session.js"
import {
  loadActiveMessages,
  loadMintedMessageIds,
  appendMessagesInTransaction
} from "./chat-transcript.js"
import { detachedWorkflowCalls } from "./detached-workflow-calls.js"
import { nextId } from "./deps.js"
import {
  makeSessionForkOrigin,
  prepareForkContext,
  sessionForkOriginMetadata
} from "./session-fork.js"
import { spawnAgentInputSchema } from "./chat-agent-spawn-input.js"
import type { PersistenceDeps } from "./deps.js"
import { isActiveRunStatus } from "@arden-hq/protocol/runs"
import { insertSession } from "./session-insert.js"
import { sessionAncestors } from "./tree-walk.js"
import { textBefore } from "../../lib/text.js"
import { spawnClientId } from "../sessions/lineage.js"
import { mutationReceiptHost, type MutationOperationIdentity } from "../tools/mutation-receipt.js"
import { sha256Hex } from "@arden-hq/std/hash"

interface SpawnParentRow extends RunRow {
  readonly public_ref: string
  readonly name: string
  readonly space_id: string | null
  readonly origin_automation_id: string | null
  readonly archived_at: string | null
  readonly session_type: string
  readonly session_metadata: string | null
}

interface SpawnLineageRow {
  readonly root_session_id: string
  readonly agent_depth: number
}

interface ExistingChildRow {
  readonly output_schema: string | null
  readonly space_id: string | null
  readonly session_id: string
  readonly public_ref: string
  readonly name: string | null
  readonly metadata: string | null
  readonly chat_model: string | null
  readonly session_type: string
  readonly run_id: string
  readonly status: string
  readonly assistant_message_id: string
  readonly model_id: string | null
  readonly reasoning_effort: string | null
  readonly last_seq: number | null
  readonly head_sequence: number | null
  readonly automation_task_id: string | null
  readonly automation_name: string | null
  readonly automation_context_mode: string | null
  readonly turn_id: string
}

const spawnError = (
  reason: "invalid_parent" | "max_depth" | "working_directory",
  message: string,
  input?: Pick<ChatWriteSpawnAgentInput["parent"], "runId" | "toolCallId">,
  cause?: unknown
): ChatAgentSpawnError =>
  new ChatAgentSpawnError({
    reason,
    retryable: false,
    message,
    ...(input === undefined ? {} : { runId: input.runId, toolCallId: input.toolCallId }),
    ...(cause === undefined ? {} : { cause })
  })

const mapSpawnFailure =
  (input: Pick<ChatWriteSpawnAgentInput["parent"], "runId" | "toolCallId">) =>
  (cause: unknown): ChatWriteSpawnAgentFailure => {
    if (
      cause instanceof ChatAgentSpawnError ||
      cause instanceof ChatWriteError ||
      cause instanceof ChatWriteConflictError
    )
      return cause
    if (cause instanceof ToolExecutionStoreError) {
      return cause.reason === "storage"
        ? writeError("spawn_agent", "storage", "Could not settle the spawn tool", {
            runId: input.runId,
            cause
          })
        : spawnError("invalid_parent", cause.message, input, cause)
    }
    return writeError("spawn_agent", "storage", "Could not spawn agent", {
      runId: input.runId,
      cause
    })
  }

export const agentSpawnResult = (
  child: {
    readonly sessionId: string
    readonly sessionRef: string
    readonly name: string | null
  },
  runId: string,
  mode: AgentMode,
  spawn: MutationOperationIdentity
): ToolResult => {
  const { sessionId, sessionRef } = child
  const childAgent = {
    session_id: sessionId,
    session_ref: sessionRef,
    run_id: runId,
    status: "running",
    mode
  } satisfies PersistedChildAgentMetadata

  return {
    content: [
      `Started independent ${mode} agent [${sessionRef}](arden:session/${sessionRef}).`,
      "Continue independent work. Use agent_message with this reference to coordinate or nudge. Its final result is delivered here automatically; do not claim its findings before that notification arrives."
    ].join(" "),
    preview: "Agent started",
    data: {
      child_agent: childAgent
    },
    host: mutationReceiptHost({
      identity: spawn,
      outcome: "applied",
      resource: {
        kind: "target",
        resourceRef: `session:${sessionId}`,
        domain: "session",
        title: child.name?.trim() || sessionRef,
        href: `arden:session/${encodeURIComponent(sessionRef)}`
      }
    })
  }
}

export const makeAgentSpawner = ({
  writer,
  chatEvents,
  sessionEvents,
  intelligence,
  rules
}: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents"> & {
  readonly intelligence: IntelligenceSettingsStore["Service"]
  readonly rules: ChatRules["Service"]
}): Pick<ChatWriteStore["Service"], "spawnAgent" | "prepareSpawnAgent"> => {
  const sql = writer.sql
  const prepareSpawnAgent = Effect.fn("SqliteChatWriteStore.prepareSpawnAgent")(function* (
    input: ChatWriteSpawnAgentInput
  ): Effect.fn.Return<
    Effect.Effect<ChatWriteSpawnAgentResult, ChatWriteSpawnAgentFailure>,
    ChatWriteSpawnAgentFailure
  > {
    const valid = yield* validateInput(spawnAgentInputSchema, input, "spawn_agent")

    return writer
      .transactInteractive(
        Effect.gen(function* () {
          const controls = yield* intelligence.settings().pipe(
            Effect.mapError((cause) =>
              writeError("spawn_agent", "storage", "Could not read agent settings", {
                runId: valid.parent.runId,
                sessionId: valid.parent.sessionId,
                cause
              })
            )
          )
          const now = yield* DateTime.now
          const timestamp = DateTime.formatIso(now)
          const parentRows = yield* sql<SpawnParentRow>`
        SELECT run.run_id, run.session_id, run.status, run.client_id,
               json_extract(run.metadata_json, '$.turn_id') AS turn_id,
               run.assistant_message_id, run.model_id, run.reasoning_effort,
               run.last_seq,
               json_extract(run.metadata_json, '$.automation.task_id') AS automation_task_id,
               json_extract(run.metadata_json, '$.automation.name') AS automation_name,
               json_extract(run.metadata_json, '$.automation.context_mode') AS automation_context_mode,
               session.public_ref, session.name, session.space_id, session.origin_automation_id,
               session.archived_at, session.session_type,
               session.metadata AS session_metadata
        FROM chat_runs AS run
        JOIN sessions AS session ON session.session_id = run.session_id
        WHERE run.run_id = ${valid.parent.runId}
          AND run.session_id = ${valid.parent.sessionId}
        LIMIT 1
      `
          const parent = parentRows[0]
          const detached =
            parent === undefined
              ? new Set<string>()
              : yield* detachedWorkflowCalls(sql, valid.parent.runId, [
                  valid.parent.toolCallId
                ]).pipe(
                  Effect.mapError((cause) =>
                    writeError(
                      "spawn_agent",
                      "storage",
                      "Could not verify the detached workflow owner",
                      { runId: valid.parent.runId, sessionId: valid.parent.sessionId, cause }
                    )
                  )
                )
          const activeParent = parent?.status === "running" || detached.size > 0
          if (parent === undefined || !activeParent || parent.archived_at !== null) {
            return yield* spawnError(
              "invalid_parent",
              "The parent agent run is not active",
              valid.parent
            )
          }
          if (typeof parent.turn_id !== "string" || parent.turn_id.length === 0) {
            return yield* writeError(
              "spawn_agent",
              "corrupt",
              "Parent Chat run has no durable turn id",
              { runId: parent.run_id, sessionId: parent.session_id }
            )
          }
          const parentAutomation = yield* runAutomationOrigin(parent, "spawn_agent")
          const parentAutomationContextMode = yield* runAutomationContextMode(parent, "spawn_agent")
          if (parentAutomation !== null && parentAutomationContextMode === null) {
            return yield* writeError(
              "spawn_agent",
              "corrupt",
              "Parent Automation run has no captured context mode",
              { runId: parent.run_id, sessionId: parent.session_id }
            )
          }

          const existingRows = yield* sql<ExistingChildRow>`
        SELECT session.session_id, session.public_ref, session.name, session.metadata, session.chat_model,
               session.session_type, session.space_id,
               run.run_id, run.status, run.assistant_message_id, run.model_id,
               run.reasoning_effort, run.last_seq,
               ${journalHeadSequenceSql(sql, sql.literal("session.session_id"))} AS head_sequence,
               json_extract(run.metadata_json, '$.turn_id') AS turn_id,
               json_extract(run.metadata_json, '$.output_schema') AS output_schema,
               json_extract(run.metadata_json, '$.automation.task_id') AS automation_task_id,
               json_extract(run.metadata_json, '$.automation.name') AS automation_name,
               json_extract(run.metadata_json, '$.automation.context_mode') AS automation_context_mode
        FROM sessions AS session
        JOIN chat_runs AS run ON run.session_id = session.session_id
        WHERE session.session_type = 'agent'
          AND session.parent_run_id = ${valid.parent.runId}
          AND session.parent_tool_call_id = ${valid.parent.toolCallId}
          AND session.archived_at IS NULL
        ORDER BY run.started_at, run.run_id
        LIMIT 1
      `
          const existing = existingRows[0]
          if (existing !== undefined) {
            if (!isActiveRunStatus(existing.status)) {
              return yield* spawnError(
                "invalid_parent",
                "The existing child agent run is no longer active",
                valid.parent
              )
            }
            const existingMetadata = yield* decodeJson(
              JsonObjectSchema,
              existing.metadata ?? "{}"
            ).pipe(
              Effect.mapError((cause) =>
                writeError("spawn_agent", "corrupt", "Agent metadata is corrupt", {
                  sessionId: existing.session_id,
                  runId: existing.run_id,
                  cause
                })
              )
            )
            const agent = readAgentSessionMetadata(existingMetadata)
            if (
              agent === null ||
              agent.mode !== valid.mode ||
              (agent.mode === "code" && agent.workspace === null)
            ) {
              return yield* writeError(
                "spawn_agent",
                "corrupt",
                "Agent sandbox metadata is invalid",
                {
                  sessionId: existing.session_id,
                  runId: existing.run_id
                }
              )
            }
            const result = agentSpawnResult(
              {
                sessionId: existing.session_id,
                sessionRef: existing.public_ref,
                name: existing.name
              },
              existing.run_id,
              agent.mode,
              valid.parent
            )
            const settled = yield* settleToolExecutionInTransaction(
              sql,
              valid.parent,
              result,
              DateTime.formatIso(yield* DateTime.now)
            )
            const activeMessages = yield* loadActiveMessages(
              sql,
              existing.session_id,
              "spawn_agent"
            )
            const automation = yield* runAutomationOrigin(existing, "spawn_agent")
            const automationContextMode = yield* runAutomationContextMode(existing, "spawn_agent")
            const scheduling = yield* schedulingForSession(
              sql,
              existing.session_id,
              existing.session_type,
              controls.maxConcurrentAgents,
              "spawn_agent"
            )
            const mintedMessageIds = yield* loadMintedMessageIds(
              sql,
              existing.session_id,
              existing.assistant_message_id,
              "spawn_agent"
            )
            return {
              result: settled,
              child: {
                runId: existing.run_id,
                sessionId: existing.session_id,
                assistantMessageId: existing.assistant_message_id,
                mintedMessageIds,
                model: existing.model_id,
                reasoningEffort: existing.reasoning_effort,
                approvalMode: "allow",
                outputSchema: yield* runOutputSchema(existing, "spawn_agent"),
                automation,
                automationContextMode,
                turnId: existing.turn_id,
                activeMessages,
                eventSequence: existing.head_sequence ?? existing.last_seq ?? 0,
                scheduling
              }
            } satisfies ChatWriteSpawnAgentResult
          }

          yield* requireRunningToolExecutionInTransaction(sql, valid.parent)

          const lineageRows = yield* sql<SpawnLineageRow>`
        WITH RECURSIVE ${sessionAncestors(sql, {
          name: "lineage",
          from: sql`SELECT session_id FROM sessions WHERE session_id = ${valid.parent.sessionId}`,
          depth: { max: 64 }
        })}
        SELECT
          (SELECT session_id FROM lineage ORDER BY depth DESC LIMIT 1) AS root_session_id,
          COALESCE(SUM(CASE WHEN session.session_type = 'agent' THEN 1 ELSE 0 END), 0) AS agent_depth
        FROM lineage JOIN sessions AS session ON session.session_id = lineage.session_id
      `
          const lineage = lineageRows[0]
          if (lineage === undefined || typeof lineage.root_session_id !== "string") {
            return yield* spawnError(
              "invalid_parent",
              "The parent Session lineage is invalid",
              valid.parent
            )
          }
          if (lineage.agent_depth + 1 >= controls.maxAgentDepth) {
            return yield* spawnError(
              "max_depth",
              controls.maxAgentDepth <= 1
                ? "Sub-agents are turned off in Settings"
                : `Sub-agents are limited to ${countOf(controls.maxAgentDepth - 1, "level")}`,
              valid.parent
            )
          }

          const childSessionId = yield* nextId
          const childRunId = yield* nextId
          const childAssistantMessageId = yield* nextId
          const childClientId = spawnClientId(valid.parent.runId, valid.parent.toolCallId)
          const childRef = friendlySessionRef(childSessionId)
          const childName = valid.name ?? textBefore(valid.task, "\n").slice(0, 160)
          const parentAgent =
            parent.session_type !== "agent"
              ? null
              : readAgentSessionMetadata(
                  yield* decodeJson(JsonObjectSchema, parent.session_metadata ?? "{}").pipe(
                    Effect.mapError((cause) =>
                      writeError("spawn_agent", "corrupt", "Parent agent metadata is corrupt", {
                        sessionId: parent.session_id,
                        runId: parent.run_id,
                        cause
                      })
                    )
                  )
                )
          if (parent.session_type === "agent" && parentAgent === null) {
            return yield* writeError("spawn_agent", "corrupt", "Parent agent metadata is invalid", {
              sessionId: parent.session_id,
              runId: parent.run_id
            })
          }
          if (
            parentAgent !== null &&
            parentAgent.mode !== "work" &&
            valid.mode !== parentAgent.mode
          ) {
            return yield* spawnError(
              "invalid_parent",
              `A ${parentAgent.mode} agent can only spawn ${parentAgent.mode} children.`,
              valid.parent
            )
          }
          let agent: NewAgentSessionMetadata
          if (valid.mode === "research") {
            agent = {
              mode: "research",
              researchWorkspaceId:
                parentAgent?.mode === "research" && parentAgent.researchWorkspaceId !== null
                  ? parentAgent.researchWorkspaceId
                  : rules.researchWorkspaceId(childSessionId)
            }
          } else if (valid.mode === "work") agent = { mode: "work" }
          else agent = { mode: "code", workspace: valid.workspace }
          const forkOriginRows =
            valid.forkHistory === undefined
              ? []
              : yield* sql<{
                  readonly through_sequence: number | null
                  readonly source_message_id: string | null
                }>`SELECT MAX(seq) AS through_sequence,
                  (SELECT message_id FROM session_messages WHERE session_id = ${parent.session_id}
                    ORDER BY seq DESC LIMIT 1) AS source_message_id
                FROM session_messages WHERE session_id = ${parent.session_id}`
          const forkOrigin =
            valid.forkHistory === undefined
              ? undefined
              : yield* makeSessionForkOrigin({
                  sourceSessionId: parent.session_id,
                  sourceSessionRef: parent.public_ref,
                  throughSequence: forkOriginRows[0]?.through_sequence ?? -1,
                  sourceMessageId: forkOriginRows[0]?.source_message_id ?? null,
                  createdAt: timestamp
                }).pipe(
                  Effect.mapError((cause) =>
                    writeError("spawn_agent", "invalid", "Agent fork origin is invalid", {
                      sessionId: parent.session_id,
                      cause
                    })
                  )
                )
          const metadata = {
            ...agentSessionMetadata(agent),
            ...(forkOrigin === undefined
              ? {}
              : { fork_origin: sessionForkOriginMetadata(forkOrigin) }),
            ...(valid.forkHistory === undefined
              ? {}
              : { fork: { at: timestamp, turn_id: parent.turn_id } })
          }
          const metadataJson = yield* encodeJson(JsonObjectSchema, metadata).pipe(
            Effect.mapError((cause) =>
              writeError("spawn_agent", "invalid", "Agent metadata cannot be encoded", {
                runId: valid.parent.runId,
                cause
              })
            )
          )
          const task = rules.agentAssignment(agent, valid.task)
          const childMessage: StoredMessageEnvelope = {
            message_id: childClientId,
            client_id: childClientId,
            role: "user",
            content: task,
            interaction: {
              kind: "assignment",
              from: { type: "agent", id: parent.public_ref, display_name: parent.name },
              to: { type: "agent", id: childRef },
              content: task,
              causedBy: { type: "tool_call", id: valid.parent.toolCallId }
            },
            created_at: timestamp
          }
          const childRunContext: RunContext = yield* withCausedBelongsTo(
            sql,
            {
              origin: { kind: "chat", session_id: parent.session_id, turn_id: parent.turn_id },
              task: yield* captureChildTask({
                sql,
                parentRunId: parent.run_id,
                requestedItemId: valid.taskItemId,
                spaceId: parent.space_id
              })
            },
            { sessionId: childSessionId, causingRunId: parent.run_id, interaction: undefined }
          ).pipe(
            Effect.mapError((cause) =>
              writeError("spawn_agent", "invalid", cause.message, { runId: parent.run_id, cause })
            )
          )
          const childPolicy = yield* captureRunPolicy(sql, {
            runId: childRunId,
            sessionId: childSessionId,
            spaceId: parent.space_id,
            mode: "worker",
            approvalMode: "ask",
            parentRunId: parent.run_id,
            ...(childRunContext.task === null ? {} : { taskItemId: childRunContext.task.item_id }),
            workerScope: workerScopes[valid.mode]
          }).pipe(
            Effect.mapError((cause) =>
              writeError("spawn_agent", "invalid", cause.message, { runId: parent.run_id, cause })
            )
          )
          const childAuthority = yield* delegateAuthority(sql, parent.run_id, {
            mode: valid.mode,
            sessionId: childSessionId,
            parentRunId: parent.run_id,
            workspaceRoot: agent.mode === "code" ? agent.workspace.root : null,
            taskItemId: childRunContext.task?.item_id ?? null
          }).pipe(
            Effect.mapError((cause) =>
              writeError("spawn_agent", "storage", "Could not record the agent's authority", {
                runId: parent.run_id,
                cause
              })
            )
          )
          const runMetadataJson = yield* encodeJson(JsonObjectSchema, {
            turn_id: childMessage.message_id,
            ...(valid.outputSchema === undefined ? {} : { output_schema: valid.outputSchema }),
            run_context: childRunContext,
            run_policy: childPolicy,
            parent_run_id: parent.run_id,
            ...(parentAutomation === null
              ? {}
              : {
                  automation: {
                    task_id: parentAutomation.automationId,
                    name: parentAutomation.name,
                    context_mode: parentAutomationContextMode
                  }
                })
          }).pipe(
            Effect.mapError((cause) =>
              writeError("spawn_agent", "invalid", "Agent run metadata cannot be encoded", {
                runId: valid.parent.runId,
                cause
              })
            )
          )
          const messageJson = yield* encodeJson(StoredMessageEnvelopeSchema, childMessage).pipe(
            Effect.mapError((cause) =>
              writeError("spawn_agent", "invalid", "Agent task cannot be encoded", {
                runId: valid.parent.runId,
                cause
              })
            )
          )

          const { projection, committed, settled } = yield* insertSession({
            sql,
            session: {
              type: "agent",
              sessionId: childSessionId,
              publicRef: childRef,
              startedAt: timestamp,
              name: childName,
              metadata: metadataJson,
              spaceId: parent.space_id,
              chatModel: valid.model ?? parent.model_id,
              originAutomationId: parentAutomation?.automationId ?? parent.origin_automation_id,
              parent: {
                sessionId: parent.session_id,
                runId: parent.run_id,
                toolCallId: valid.parent.toolCallId
              }
            },
            lifecycle: {
              kind: "announce",
              events: sessionEvents,
              complete: Effect.gen(function* () {
                const forked =
                  valid.forkHistory === undefined
                    ? []
                    : yield* prepareForkContext({
                        history: valid.forkHistory,
                        parentSessionId: parent.session_id,
                        forkId: valid.parent.toolCallId,
                        closeOpenCall: (id) =>
                          id === valid.parent.toolCallId
                            ? "This call started you. Your task follows."
                            : "This call belongs to the agent that started you; its result is not available to you.",
                        timestamp,
                        operation: "spawn_agent",
                        presentation: "inherited"
                      })
                const projection = yield* appendMessagesInTransaction(
                  sql,
                  childSessionId,
                  [...forked, childMessage],
                  timestamp,
                  "spawn_agent",
                  childMessage.message_id
                )
                yield* sql`
              INSERT INTO chat_runs (
                run_id, session_id, status, started_at, updated_at, metadata_json,
                client_id, assistant_message_id, model_id, reasoning_effort, authority_json
              ) VALUES (
                ${childRunId}, ${childSessionId}, 'running', ${timestamp}, ${timestamp}, ${runMetadataJson},
                ${childClientId}, ${childAssistantMessageId}, ${valid.model ?? parent.model_id},
                ${valid.reasoningEffort ?? (valid.model === undefined ? parent.reasoning_effort : null)},
                ${JSON.stringify(childAuthority)}
              )
            `
                yield* recordChildAttempt({
                  sql,
                  runId: childRunId,
                  sessionId: childSessionId,
                  context: childRunContext,
                  now: timestamp
                }).pipe(
                  Effect.mapError((cause) =>
                    writeError("spawn_agent", "storage", cause.message, {
                      runId: childRunId,
                      cause
                    })
                  )
                )
                yield* sql`
              INSERT INTO chat_idempotency_keys (
                session_id, client_id, request_hash, run_id, message_id, message_json,
                status, created_at, updated_at
              ) VALUES (
                ${childSessionId}, ${childClientId},
                ${sha256Hex(valid.task)},
                ${childRunId}, ${childMessage.message_id}, ${messageJson},
                'running', ${timestamp}, ${timestamp}
              )
            `

                const committed = yield* chatEvents
                  .appendInTransaction({
                    sessionId: childSessionId,
                    events: [
                      {
                        event: {
                          type: "RUN_STARTED",
                          run_id: childRunId,
                          session_id: childSessionId,
                          turn_id: childMessage.message_id,
                          ...(parentAutomation === null || parentAutomationContextMode === null
                            ? {}
                            : {
                                is_meta_run: true,
                                automation_task_id: parentAutomation.automationId,
                                automation_name: parentAutomation.name,
                                automation_context_mode: parentAutomationContextMode
                              })
                        } satisfies ChatProjectionEvent,
                        runId: childRunId
                      },
                      {
                        event: {
                          type: "TEXT_MESSAGE_START",
                          message_id: childAssistantMessageId,
                          role: "assistant"
                        } satisfies ChatProjectionEvent,
                        runId: childRunId
                      }
                    ]
                  })
                  .pipe(
                    Effect.mapError((cause) =>
                      writeError("spawn_agent", "storage", "Could not commit child run events", {
                        sessionId: childSessionId,
                        runId: childRunId,
                        cause
                      })
                    )
                  )
                yield* setCheckpoint(
                  sql,
                  chatEvents,
                  childSessionId,
                  childRunId,
                  committed.headSequence,
                  "spawn_agent"
                )

                const result = agentSpawnResult(
                  { sessionId: childSessionId, sessionRef: childRef, name: childName },
                  childRunId,
                  valid.mode,
                  valid.parent
                )
                const settled = yield* settleToolExecutionInTransaction(
                  sql,
                  valid.parent,
                  result,
                  DateTime.formatIso(yield* DateTime.now)
                )
                return { projection, committed, settled }
              })
            }
          })
          return {
            result: settled,
            child: {
              runId: childRunId,
              sessionId: childSessionId,
              assistantMessageId: childAssistantMessageId,
              mintedMessageIds: [],
              model: valid.model ?? parent.model_id,
              reasoningEffort:
                valid.reasoningEffort ??
                (valid.model === undefined ? parent.reasoning_effort : null),
              approvalMode: "allow",
              outputSchema: valid.outputSchema ?? null,
              automation: parentAutomation,
              automationContextMode: parentAutomationContextMode,
              turnId: childMessage.message_id,
              activeMessages: projection,
              eventSequence: committed.headSequence,
              scheduling: {
                kind: "agent_tree",
                treeRootSessionId: lineage.root_session_id,
                maxConcurrentAgents: controls.maxConcurrentAgents
              }
            }
          } satisfies ChatWriteSpawnAgentResult
        })
      )
      .pipe(Effect.mapError(mapSpawnFailure(valid.parent)))
  })

  return {
    prepareSpawnAgent,
    spawnAgent: (input) => prepareSpawnAgent(input).pipe(Effect.flatten)
  }
}
