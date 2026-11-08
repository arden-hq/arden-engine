import { cutText } from "@arden-hq/std/text"
import type { ToolCall } from "@arden-hq/loop"
import { Effect, Option, Schema } from "effect"
import { InteractionSchema } from "@arden-hq/protocol/effect/chat"
import type { StructuredCompletion } from "../models/structured-completion.js"
import type { ChatWriteStore } from "../persistence/chat/store.js"
import type { ChatEventStore } from "../persistence/events/store.js"
import type { RunQueries } from "../persistence/runs/queries.js"
import type { TranscriptQueries } from "../persistence/transcript/queries.js"
import { PROMPT_TEXT } from "../prompts/catalog.js"
import {
  whileRunActive,
  advanceEventSequence,
  type ToolHost,
  type ToolRun
} from "./durable-tools.js"

export interface RunPurposeInput {
  readonly run: ToolRun
  readonly turnId: string
  readonly batch: ReadonlyArray<ToolCall>
  readonly unchanged: () => boolean
}

export const makeRunPurpose = (input: {
  readonly completion: StructuredCompletion["Service"]
  readonly lifecycle: ToolHost["lifecycle"]
  readonly store: ChatWriteStore["Service"]
  readonly events: ChatEventStore["Service"]
  readonly runs: RunQueries["Service"]
  readonly transcript: TranscriptQueries["Service"]
}): ((request: RunPurposeInput) => Effect.Effect<void, unknown>) =>
  Effect.fn("RunPurpose.generate")(function* (request: RunPurposeInput) {
    const taskDescription = request.batch.length === 0
    const currentPurpose = () => {
      const activity = input.events.currentActivity(request.run.sessionId, request.run.runId)
      return (taskDescription ? activity?.run_purpose : activity?.purpose) ?? undefined
    }
    const previousPurpose = currentPurpose()
    const admissible = Effect.fn("RunPurpose.admissible")(function* () {
      if (
        request.run.signal.aborted ||
        !request.unchanged() ||
        (taskDescription && currentPurpose() !== previousPurpose)
      )
        return false
      const run = yield* input.runs.get(request.run.runId)
      return run?.status === "running" && !(yield* input.store.peekPendingInput(request.run.runId))
    })
    if (!(yield* whileRunActive(input, request.run, admissible()))) return
    const inputs = yield* input.transcript.turnInputs({
      sessionId: request.run.sessionId,
      turnId: request.turnId
    })
    const result = yield* input.completion.runTool({
      role: "helper",
      usage: { kind: "run_activity", owner: { type: "session", sessionId: request.run.sessionId } },
      system: PROMPT_TEXT.runPurpose,
      user: JSON.stringify({
        current_task: previousPurpose,
        conversation: [
          ...inputs
            .filter((message) => {
              const interaction = Schema.decodeUnknownOption(InteractionSchema)(message.interaction)
              return (
                Option.isNone(interaction) ||
                (interaction.value.kind !== "completion" && interaction.value.from.type !== "tool")
              )
            })
            .map((message) => ({
              role: message.role,
              content: cutText(JSON.stringify(message.content), 2_000)
            })),
          ...(request.batch.length > 0
            ? [
                {
                  role: "assistant",
                  content: "null",
                  tool_calls: request.batch.map((call) => ({
                    id: call.id,
                    name: call.function.name,
                    arguments: cutText(call.function.arguments, 500),
                    display_title: call.display_title
                  }))
                }
              ]
            : [])
        ]
      }),
      maxOutputTokens: 100,
      signal: request.run.signal,
      result: {
        schema: Schema.Struct({
          description: Schema.NonEmptyString.check(Schema.isMaxLength(160))
        }),
        name: "describe_activity",
        displayName: "Describe activity",
        description: "Submit current high-level action in 3-8 words"
      }
    })
    const text = result.description.replace(/\s+/g, " ").trim()
    if (text.length === 0) return
    yield* whileRunActive(
      input,
      request.run,
      Effect.gen(function* () {
        if (!(yield* admissible()) || (taskDescription && text === currentPurpose())) return
        const committed = yield* input.events.append({
          sessionId: request.run.sessionId,
          events: [
            {
              event: {
                type: "run_activity",
                run_id: request.run.runId,
                description: text,
                ...(taskDescription ? {} : { tool_call_ids: request.batch.map((call) => call.id) })
              },
              runId: request.run.runId
            }
          ]
        })
        advanceEventSequence(request.run, committed)
      })
    )
  })
