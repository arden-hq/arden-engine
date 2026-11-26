import { type RunContext } from "../runs/stored-context.js"
import { delegatedCauses } from "../transcript/run-causes.js"
import { INTERACTION_KIND, INTERACTION_SOURCE, ROLE } from "@arden-hq/std/message-vocabulary"
import { countOf } from "@arden-hq/std/count"
import { storedSender } from "../transcript/interaction.js"
import type { ChatProjectionEvent } from "@arden-hq/protocol"
import { DateTime, Effect } from "effect"
import {
  type ChatWriteStore,
  type ChatWriteSpawnAgentInput,
  type ChatWriteSpawnAgentResult,
  type ChatWriteSpawnAgentFailure
} from "../chat/store.js"
import type { IntelligenceSettingsStore } from "../settings/store.js"
import type { ChatRules } from "../chat/rules.js"
import { JsonObjectSchema } from "../json.js"
import { StoredMessageEnvelopeSchema, type StoredMessageEnvelope } from "../transcript/model.js"
import {
  agentSessionMetadata,
  readAgentSessionMetadata,
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
import { setCheckpoint } from "./chat-run.js"
import { appendMessagesInTransaction } from "./chat-transcript.js"
import { nextId } from "./deps.js"
import {
  makeSessionForkOrigin,
  prepareForkContext,
  sessionForkOriginMetadata
} from "./session-fork.js"
import { spawnAgentInputSchema } from "./chat-agent-spawn-input.js"
import type { PersistenceDeps } from "./deps.js"
import { insertSession } from "./session-insert.js"
import { sessionAncestors } from "./tree-walk.js"
import { textBefore } from "../../lib/text.js"
import { spawnClientId } from "../sessions/lineage.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { insertChatKey } from "./chat-key-message.js"
import { assistantTextStart } from "./assistant-text-start.js"
import {
  type SpawnLineageRow,
  agentSpawnResult,
  mapSpawnFailure,
  spawnError
} from "./chat-agent-spawn-rows.js"
import { loadSpawnParent } from "./chat-spawn-parent.js"
import { existingSpawnChild } from "./chat-spawn-existing.js"

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
          const { parent, parentAutomation, parentAutomationContextMode } = yield* loadSpawnParent(
            sql,
            valid
          )
          const existingChild = yield* existingSpawnChild(sql, valid, controls)
          if (existingChild !== undefined) return existingChild

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
          const childModel = valid.model ?? valid.defaultModel?.model ?? parent.model_id
          const inheritedEffort =
            valid.defaultModel === undefined
              ? parent.reasoning_effort
              : valid.defaultModel.reasoningEffort
          const childEffort =
            valid.reasoningEffort ?? (valid.model === undefined ? inheritedEffort : null)
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
            role: ROLE.interaction,
            content: task,
            ...storedSender({
              kind: INTERACTION_KIND.assignment,
              from: { source: INTERACTION_SOURCE.agent, id: parent.public_ref, name: parent.name },
              to: { source: INTERACTION_SOURCE.agent, id: childRef },
              caused_by: { type: "tool_call", id: valid.parent.toolCallId }
            }),
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
            { sessionId: childSessionId, causingRunId: parent.run_id, sender: undefined }
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
              chatModel: childModel,
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
                ${childClientId}, ${childAssistantMessageId}, ${childModel},
                ${childEffort},
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
                yield* insertChatKey(sql, {
                  sessionId: childSessionId,
                  clientId: childClientId,
                  requestHash: sha256Hex(valid.task),
                  runId: childRunId,
                  messageId: childMessage.message_id,
                  messageJson,
                  status: "running",
                  at: timestamp
                })

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
                          causes: delegatedCauses(parentAutomation, parentAutomationContextMode)
                        } satisfies ChatProjectionEvent,
                        runId: childRunId
                      },
                      {
                        event: assistantTextStart(childAssistantMessageId),
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
              model: childModel,
              reasoningEffort: childEffort,
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
