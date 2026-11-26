import { boundAuthority } from "./run-authority.js"
import { Context, Effect } from "effect"
import { RunQueries } from "../persistence/runs/queries.js"
import { runPolicyOf } from "../execution/policy.js"
import type { ServerToolRun } from "./runner-contract.js"
import { chatRunnerSource } from "./runner-source.js"
import { makeDurableTools, type ToolHost } from "./durable-tools.js"
import { type RunServices } from "./run-driver-support.js"
import { ChatMessageError } from "./message-errors.js"

export type DetachedRun = (input: {
  readonly sessionId: string
  readonly runId: string
}) => Effect.Effect<ServerToolRun, ChatMessageError>

export const makeDetachedRun = ({
  runServices,
  runs,
  chatRunner,
  toolHost
}: {
  readonly runServices: Context.Context<RunServices>
  readonly runs: RunQueries["Service"]
  readonly chatRunner: ReturnType<typeof chatRunnerSource>
  readonly toolHost: () => ToolHost
}): DetachedRun => {
  const detachedRun = Effect.fn("ChatMessage.detachedRun")(function* (input: {
    readonly sessionId: string
    readonly runId: string
  }): Effect.fn.Return<ServerToolRun, ChatMessageError> {
    if (chatRunner.current() === undefined) {
      return yield* new ChatMessageError({
        reason: "unavailable",
        message: "Chat model runner is not configured",
        sessionId: input.sessionId
      })
    }
    const policy = yield* runs.get(input.runId).pipe(
      Effect.flatMap(runPolicyOf),
      Effect.mapError(
        (cause) =>
          new ChatMessageError({
            reason: "unavailable",
            message: "The Run's captured policy is unavailable",
            sessionId: input.sessionId,
            cause
          })
      )
    )
    const tools = yield* makeDurableTools(toolHost(), {
      sessionId: input.sessionId,
      runId: input.runId,
      signal: AbortSignal.any([]),
      eventSequence: { value: undefined }
    }).pipe(Effect.provideContext(runServices))
    const authority = yield* boundAuthority(runs, input)
    return {
      sessionId: input.sessionId,
      runId: input.runId,
      policy,
      authority,
      approvalMode: "ask",
      executeTool: tools.execute,
      executeDetachedTool: tools.executeDetached,
      spawnAgent: tools.spawnAgent,
      cancelAgent: tools.cancelAgent,
      sendMessage: tools.sendMessage,
      detachedRun: tools.detachedRun,
      emitToolProgress: tools.emitToolProgress,
      emitToolOutput: tools.emitToolOutput,
      declareEffectTarget: tools.declareEffectTarget
    } satisfies ServerToolRun
  })
  return detachedRun
}
