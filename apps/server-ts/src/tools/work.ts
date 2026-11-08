import { ToolExecutionError } from "@arden-hq/loop"
import { Effect, Schema } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { WorkStore } from "../persistence/work/store.js"
import { readSpecialChat } from "../context/special-chat.js"
import { toolFailure } from "./tool-failure.js"
import { AskUserParametersSchema, askUserQuestion, permissionRequest } from "./ask-user-input.js"
import { recordApplied } from "../execution/tool-effect.js"
import { takesAnswersMidRun } from "../execution/authority.js"
import { FocusChoiceStore } from "../persistence/focus-choices/store.js"
import { appliedReceipt, inChatTarget } from "./call-receipt.js"
import type { ServerRunContext } from "./run-context.js"

interface WorkToolServices {
  readonly work: WorkStore["Service"]
  readonly sessions: SessionQueries["Service"]
  readonly focusChoices: FocusChoiceStore["Service"]
}

const BringBackParametersSchema = Schema.Struct({
  thread_id: Schema.NonEmptyString.annotate({
    description: "The thread's id from the Threads context."
  })
})

const makeWorkTools = (services: WorkToolServices): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "ask_user",
    description:
      'Ask one specific question in everyday language. Questions block by default. Only add timeout with an explicit first-choice fallback for work you already have authority to do; never time out a request for approval or permission. Ask for the concrete action or decision itself — "Reconnect Gmail for tim@example.com?", "Sign in to LinkedIn in the in-app browser, then answer Done" — never describe your own state ("I need some input"). When the answers are choices, the question names them: "Send the draft, or keep editing?", not "Still want this?"; put why you ask in detail. Keep answer labels short and concrete, such as \'Describe the task\' rather than \'Provide the specific objective\'. For a review or action on something outside the card, detail must include the actual material or a direct Markdown link labeled for the action. Reuse an exact destination returned by a tool; never ask the user to find the item or link only to its parent Task when a file link exists. The question stays open after this Run ends, in Chat, Task peek and the Inbox; a Task is optional. Never say where its card sits ("above", "below"). Do not poll or repeat the question. This records a question, never an approval to perform an external action.',
    parameters: Schema.toStandardSchemaV1(AskUserParametersSchema),
    metadata: {
      effect: "run_record",
      outcome: true,
      display_name: "Ask you",
      kind: "tool",
      action: "write",
      source: "_spaces",
      changes_state: true,
      target: "reported",
      destructive: false,
      concurrency_group: "space_work",
      approval_preview: "Ask a question in this conversation."
    },
    execute: async (input, ctx, effects) => {
      if (input.permission !== undefined) {
        const offered = await ctx.run.offerPermission({
          toolCallId: ctx.toolCallId,
          request: permissionRequest(input.permission)
        })
        if (offered.kind === "offered") effects.applied()
        if (offered.kind !== "offered")
          return {
            result: `No card shown. ${offered.kind === "refused" ? offered.reason : "Nothing to offer."}`,
            preview: "No permission offered"
          }
        return {
          result: `Offered: ${offered.prompt} (question_id ${offered.questionId}). The user sees it as a card in Chat; only their tap saves it, so do not say it is saved. Carry on with the work; their answer arrives at your next step.`,
          preview: `Offered: ${offered.prompt}`,
          host: appliedReceipt(
            ctx,
            inChatTarget({
              resourceRef: `question:${offered.questionId}`,
              title: offered.prompt,
              chat: await thisChat(services, ctx.run)
            })
          )
        }
      }
      const { content, focusTarget } = askUserQuestion(input)
      const first = content.choices[0]
      if (input.timeout !== undefined && first === undefined)
        throw new ToolExecutionError("A timed question needs an explicit first choice")
      const timeout =
        input.timeout !== undefined && first !== undefined
          ? { seconds: input.timeout.seconds ?? 120, fallbackChoiceId: first.id }
          : undefined
      const question = await recordApplied(
        effects,
        Effect.runPromise(
          services.work
            .askQuestion({
              runId: ctx.run.runId,
              toolCallId: ctx.toolCallId,
              content,
              ...(timeout === undefined ? {} : { timeout }),
              ...(focusTarget === undefined ? {} : { focusTarget })
            })
            .pipe(Effect.mapError((error) => toolFailure(error, "Question not asked"))),
          { signal: ctx.signal }
        )
      )
      const chat = await Effect.runPromise(
        services.sessions.loadHeaderSnapshot(ctx.run.sessionId).pipe(
          Effect.map((session) => ({
            onboarding:
              session !== null && readSpecialChat(session.metadata)?.kind === "onboarding",
            agentChat: session?.header.sessionType === "agent",
            header: session?.header
          })),
          Effect.orElseSucceed(() => ({ onboarding: false, agentChat: false, header: undefined }))
        ),
        { signal: ctx.signal }
      )
      const onboarding = chat.onboarding
      const waitingNote = (() => {
        if (timeout !== undefined)
          return `If no answer arrives within ${timeout.seconds} seconds, your first-choice fallback resumes this work under existing authority. Do independent work or end this Run while waiting. Do not poll, repeat the question, or treat silence as consent.`
        if (focusTarget !== undefined)
          return "Wait for the user's choice: end this turn now with no text and do no work on the thread. Continue here, or any message the user types here, ends the wait: the thread's work then goes on in this chat in that turn, beside whatever else the message asks. The other chat, if chosen, receives the user's message and answers it there."
        return takesAnswersMidRun(ctx.run.authority.actor, chat.agentChat)
          ? "Continue independent work — if the user answers while you work, the answer arrives at your next step — or end this Run while waiting for the answer."
          : "Continue independent work, or end this Run while waiting for the answer."
      })()
      return {
        result: onboarding
          ? `Asked question_id ${question.question_id}. The card is showing. End your turn now with no text; an answer or Skip starts the next turn.`
          : `Asked question_id ${question.question_id}. The user sees it as a card in Chat; never say where it sits ("above", "below") — call it the question, or name the choice. ${waitingNote}`,
        preview: question.content.prompt,
        data: { question },
        host: appliedReceipt(
          ctx,
          inChatTarget({
            resourceRef: `question:${question.question_id}`,
            title: question.content.prompt,
            chat: chat.header
          })
        )
      }
    }
  }),
  defineServerTool({
    name: "permissions_read",
    description:
      "Read this chat's approval mode, the permission rules it follows (its Space's list and Everywhere, with each rule's id), and the tools whose own check still asks for some calls in this mode whatever the rules say. Call it before you tell the user what a mode or rule covers, and before you offer to change or remove a rule.",
    parameters: Schema.toStandardSchemaV1(Schema.Struct({})),
    metadata: {
      effect: "none",
      display_name: "Read Permissions",
      kind: "tool",
      action: "read",
      approval_preview: "Read this chat's permissions.",
      source: "_system",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async (_input, ctx) => {
      if (ctx.run.authority.actor.kind !== "person")
        throw new ToolExecutionError(
          "Only the person's own chat reads its permission rules. If a call is refused, say so in your report.",
          { preview: "Not available here", retryable: false }
        )
      const view = await ctx.run.readPermissions()
      return {
        result: JSON.stringify({
          approval_mode: view.mode,
          mode_set_by: view.modeSetBy,
          rules: view.rules,
          own_checks_still_ask: view.ownChecks
        }),
        preview: `${view.mode}, ${view.rules.length} rules`
      }
    }
  }),
  defineServerTool({
    name: "thread_bring_back",
    description:
      "Bring a thread that moved to another chat back into this chat, when the user asks to continue it here. thread_id is the id the Threads context names. The other chat stops working on it; continue the thread here afterwards. Never call it on your own initiative.",
    parameters: Schema.toStandardSchemaV1(BringBackParametersSchema),
    metadata: {
      effect: "arden_db",
      display_name: "Bring thread back",
      kind: "tool",
      action: "write",
      source: "_spaces",
      changes_state: true,
      target: "reported",
      destructive: false,
      idempotent: true,
      concurrency_group: "space_work",
      approval_preview: "Bring a thread back to this chat."
    },
    execute: async (input, ctx, effects) => {
      await recordApplied(
        effects,
        Effect.runPromise(
          services.focusChoices
            .bringBack({
              threadId: input.thread_id,
              sessionId: ctx.run.sessionId,
              clientId: `bring-back:${ctx.run.runId}:${ctx.toolCallId}`
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new ToolExecutionError(error.message, {
                    preview: "Thread not brought back",
                    retryable: false
                  })
              )
            ),
          { signal: ctx.signal }
        )
      )
      const [threads, chat] = await Promise.all([
        Effect.runPromise(
          services.focusChoices.threads(ctx.run.sessionId).pipe(Effect.orElseSucceed(() => [])),
          { signal: ctx.signal }
        ),
        thisChat(services, ctx.run)
      ])
      const thread = threads.find((record) => record.threadId === input.thread_id)
      return {
        result:
          "The thread is back in this chat; the other chat stopped working on it. Continue it here now.",
        preview: "Thread brought back",
        host: appliedReceipt(
          ctx,
          inChatTarget({
            resourceRef: `thread:${input.thread_id}`,
            title: thread?.name ?? "Thread",
            chat
          })
        )
      }
    }
  })
]

const thisChat = (
  services: WorkToolServices,
  run: Pick<ServerRunContext, "sessionId">
): Promise<{ readonly publicRef: string } | undefined> =>
  Effect.runPromise(
    services.sessions.loadHistoryHeader(run.sessionId).pipe(
      Effect.map((header) => header ?? undefined),
      Effect.orElseSucceed(() => undefined)
    )
  )

export const workTools = Effect.gen(function* () {
  return makeWorkTools({
    work: yield* WorkStore,
    sessions: yield* SessionQueries,
    focusChoices: yield* FocusChoiceStore
  })
})
