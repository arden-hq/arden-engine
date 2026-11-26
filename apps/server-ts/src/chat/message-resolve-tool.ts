import type { ToolDecisionFields } from "../persistence/chat/send-contracts.js"
import type { ChatAcknowledgement } from "@arden-hq/protocol/chat"
import { Effect, Fiber, FiberMap, Option, Semaphore } from "effect"
import { ChatWriteStore, type ChatWriteResume } from "../persistence/chat/store.js"
import {
  ToolExecutionStore,
  type ApprovalAlternativeInput,
  type ApprovalEditsInput
} from "../persistence/tools/store.js"
import { chatRunnerSource } from "./runner-source.js"
import { mapToolStoreError, mapWriteError, type ChatMessageFailure } from "./message-errors.js"

interface ResolveToolInput extends Omit<ToolDecisionFields, "alternative"> {
  readonly edits?: ApprovalEditsInput
  readonly alternative?: ApprovalAlternativeInput
}

export type ResolveTool = (
  input: ResolveToolInput
) => Effect.Effect<{ readonly status: "ok" }, ChatMessageFailure>

export const makeResolveTool = ({
  store,
  toolStore,
  fibers,
  lifecycle,
  chatRunner,
  launch
}: {
  readonly store: ChatWriteStore["Service"]
  readonly toolStore: ToolExecutionStore["Service"]
  readonly fibers: FiberMap.FiberMap<string, void, unknown>
  readonly lifecycle: Semaphore.Semaphore
  readonly chatRunner: ReturnType<typeof chatRunnerSource>
  readonly launch: (run: ChatWriteResume) => Effect.Effect<void>
}): ResolveTool => {
  const resolveTool = Effect.fn("ChatMessage.resolveTool")(function* (
    input: Omit<ToolDecisionFields, "alternative"> & {
      readonly edits?: ApprovalEditsInput
      readonly alternative?: ApprovalAlternativeInput
    }
  ) {
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const active = yield* FiberMap.get(fibers, input.runId)
        if (Option.isSome(active)) yield* Fiber.await(active.value)
        return yield* lifecycle.withPermit(
          Effect.gen(function* () {
            const resolution = yield* toolStore
              .resolve({
                runId: input.runId,
                toolCallId: input.toolId,
                feedback: input.result,
                ...(input.approved === undefined ? {} : { approved: input.approved }),
                ...(input.grantStanding === undefined
                  ? {}
                  : { grantStanding: input.grantStanding }),
                ...(input.grantList === undefined ? {} : { grantList: input.grantList }),
                ...(input.attachFolderToSpace === undefined
                  ? {}
                  : { attachFolderToSpace: input.attachFolderToSpace }),
                ...(input.edits === undefined ? {} : { edits: input.edits }),
                ...(input.alternative === undefined ? {} : { alternative: input.alternative }),
                ...(input.askedAt === undefined ? {} : { askedAt: input.askedAt }),
                ...(input.commandId === undefined ? {} : { commandId: input.commandId })
              })
              .pipe(Effect.mapError(mapToolStoreError))
            if (resolution.ready && chatRunner.current() !== undefined) {
              const claimed = yield* store
                .claimResume(resolution.runId)
                .pipe(Effect.mapError(mapWriteError))
              if (claimed !== null) yield* launch(claimed)
            }
            return { status: "ok" } satisfies ChatAcknowledgement
          })
        )
      })
    )
  })
  return resolveTool
}
