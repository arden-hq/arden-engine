import { INTERACTION_KIND, INTERACTION_SOURCE } from "@arden-hq/std/message-vocabulary"
import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import { sessionLineage } from "../persistence/sessions/lineage.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { SessionStore } from "../persistence/sessions/store.js"
import { recordApplied } from "../execution/tool-effect.js"
import { appliedReceipt, chatTarget } from "./call-receipt.js"
import { chatHref, chatRefOf } from "../sessions/chat-href.js"

const makeAgentMessageTool = (services: {
  readonly sessions: SessionQueries["Service"]
  readonly store: SessionStore["Service"]
}): ServerTool =>
  defineServerTool({
    name: "agent_message",
    summary: "Sends a note to another agent that is working for you.",
    discovery: "always_loaded",
    description:
      "Send a correction, question, or follow-up to your parent, child, or another agent in this conversation's family; interim news for whoever waits on your run goes through tell. Use its exact session_ref or arden:session/ link. A running recipient receives it at a model-step boundary; an idle recipient starts a continuation unless wake is false. A parent woken by a child's message keeps the permissions its task already had. Sending does not interrupt a running tool or widen anyone's permissions. Do not send acknowledgments or repeat automatically delivered final results.",
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        wake: Schema.optionalKey(Schema.Boolean).annotate({
          description:
            "Default true: start a turn if idle. False: store for the next turn. Neither interrupts an active turn."
        }),
        session_ref: Schema.NonEmptyString.check(Schema.isMaxLength(300)).annotate({
          description:
            "Exact session_ref or arden:session/<session_ref> link from agent context or spawn_agent."
        }),
        message: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).pipe(
          Schema.annotateEncoded({
            description:
              "Self-contained information or follow-up within the existing authorized task."
          })
        )
      })
    ),
    metadata: {
      effect: "arden_db",
      scopes: ["agent_research", "agent_code"],
      code_mode: false,
      display_name: "Message Agent",
      kind: "tool",
      action: "execute",
      source: "_agents",
      approval_preview: "Send a note to another agent working for you.",
      changes_state: true,
      target: "reported",
      concurrency_group: "agent_messages",
      destructive: false
    },
    execute: async (input, ctx, effects) => {
      const ref = chatRefOf(input.session_ref)
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const matches = yield* services.store.list({ scope: "all", sessionRef: ref, limit: 1 })
          const target = matches[0]
          if (!target || target.sessionId === ctx.run.sessionId) {
            return yield* Effect.fail(
              new ToolExecutionError("Choose another existing Session in this agent family.")
            )
          }
          const [sender, recipient] = yield* Effect.all(
            [
              sessionLineage(services.sessions, ctx.run.sessionId),
              sessionLineage(services.sessions, target.sessionId)
            ],
            { concurrency: "unbounded" }
          )
          if (sender.at(-1)?.sessionId !== recipient.at(-1)?.sessionId) {
            return yield* Effect.fail(
              new ToolExecutionError(
                "This Session is outside your agent family. Use session_send_message for separately authorized cross-conversation work."
              )
            )
          }
          const source = sender[0]
          const destination = recipient[0]
          if (!source || !destination) {
            return yield* Effect.fail(
              new ToolExecutionError("Agent family identity is unavailable.")
            )
          }
          const sources = yield* services.store.list({
            scope: "all",
            sessionRef: source.publicRef,
            limit: 1
          })
          const sourceSession = sources[0]
          if (!sourceSession) {
            return yield* Effect.fail(
              new ToolExecutionError("Agent sender identity is unavailable.")
            )
          }
          const sourceName = sourceSession.name?.trim() || source.publicRef
          return { target, source, sourceName, destination }
        }),
        { signal: ctx.signal }
      )
      const targetLink = chatHref({ publicRef: result.destination.publicRef })
      const receipt = await recordApplied(
        effects,
        ctx.run.sendMessage({
          sessionId: result.target.sessionId,
          clientId: `agent-message:${ctx.run.runId}:${ctx.toolCallId}`,
          wake: input.wake ?? true,
          message: input.message,
          sender: {
            kind: INTERACTION_KIND.message,
            from: {
              source: INTERACTION_SOURCE.agent,
              id: result.source.publicRef,
              name: result.sourceName
            },
            to: { source: INTERACTION_SOURCE.agent, id: result.destination.publicRef },
            caused_by: { type: "tool_call", id: ctx.toolCallId }
          }
        })
      )
      return {
        result: `Sent to [${result.destination.publicRef}](${targetLink}). Stored for the recipient; this receipt does not confirm that it has read or applied the message.`,
        preview: "Agent message sent",
        data: { status: receipt.status, session_ref: result.destination.publicRef },
        host: appliedReceipt(
          ctx,
          chatTarget(
            result.destination,
            result.destination.name?.trim() || result.destination.publicRef
          )
        )
      }
    }
  })

export const agentMessageTools = Effect.gen(function* () {
  return [makeAgentMessageTool({ sessions: yield* SessionQueries, store: yield* SessionStore })]
})
