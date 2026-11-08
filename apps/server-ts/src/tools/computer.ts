import { Effect, Schema } from "effect"
import { ToolExecutionError, type ModelContentBlock } from "@arden-hq/loop"
import { ComputerKernel } from "../computer/kernel.js"
import { ComputerService } from "../computer/service.js"
import { KeyedSerialQueue } from "../mcp/serial.js"
import { appTarget } from "./action-targets.js"
import { defineServerTool } from "./define.js"
import { computerNativeTools } from "./computer-native.js"
import { isComputerStep, type ComputerStep } from "@arden-hq/protocol/computer"
import { scriptStep } from "../computer/step.js"
import { COMPUTER_TOOL, NESTED_CALL_MARKERS } from "../persistence/tools/tool-roles.js"
import { currentMillis } from "../runtime/clock.js"

const OPERATIONS = new Set([
  "computer_launch",
  "computer_clipboard_write",
  "computer_read",
  "computer_act",
  "browser_tabs",
  "browser_snapshot",
  "browser_screenshot",
  "browser_act",
  "browser_pointer",
  "browser_wait"
])
const CellSchema = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000))
})
const EmptySchema = Schema.Struct({})

export const computerTools = Effect.gen(function* () {
  const { driver, control } = yield* ComputerService
  const sessions = new Map<
    string,
    { kernel: ComputerKernel; touched: number; generation: number }
  >()
  const queue = new KeyedSerialQueue()
  const expire = (): void => {
    for (const [id, session] of sessions) {
      if (currentMillis() - session.touched > 15 * 60_000) {
        session.kernel.close()
        sessions.delete(id)
      }
    }
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const timer = setInterval(expire, 60_000)
      timer.unref()
      return timer
    }),
    (timer) =>
      Effect.promise(async () => {
        clearInterval(timer)
        for (const session of sessions.values()) session.kernel.close()
        sessions.clear()
      })
  )
  return [
    ...computerNativeTools(driver, control),
    defineServerTool({
      name: COMPUTER_TOOL,
      description:
        "Run a computer-use JavaScript cell in an isolated persistent session for this chat; the computer-use Skill has the cua API. state holds values and handles between calls; locals do not persist. Every child operation is authorized and recorded separately. Await every call and return compact JSON; screenshots are forwarded automatically. No filesystem, process, network or imports. Settled script errors preserve state. Cancellation, unfinished calls, inactivity or restart discard the heap; reacquire and observe. Never replay uncertain inputs.",
      parameters: Schema.toStandardSchemaV1(CellSchema),
      metadata: {
        effect: "run_record",
        changes_state: false,
        action: "read",
        display_name: "Computer script",
        kind: "computer",
        source: "_computer",
        concurrency_group: "computer_repl",
        destructive: false,
        idempotent: false,
        code_mode: false
      },
      execute: async (input, ctx, effects) => {
        const signal = control.signal(ctx.signal)
        return queue.run(ctx.run.sessionId, async () => {
          signal.throwIfAborted()
          expire()
          let session = sessions.get(ctx.run.sessionId)
          if (session !== undefined && session.generation !== control.generation) {
            session.kernel.close()
            sessions.delete(ctx.run.sessionId)
            session = undefined
          }
          if (session === undefined) {
            if (sessions.size >= 16)
              throw new ToolExecutionError(
                "Computer session limit reached; reset an unused chat session",
                { preview: "Computer session limit", retryable: false }
              )
            session = {
              kernel: await ComputerKernel.create(),
              touched: currentMillis(),
              generation: control.generation
            }
            sessions.set(ctx.run.sessionId, session)
          }
          session.touched = currentMillis()
          const media: ModelContentBlock[] = []
          const steps: ComputerStep[] = []
          effects.sent()
          try {
            const value = await session.kernel.execute({
              code: input.code,
              signal,
              call: async (name, args, index, signal) => {
                if (!OPERATIONS.has(name))
                  throw new Error("Operation unavailable in computer scripts")
                signal.throwIfAborted()
                return ctx.run.codeMode.call({
                  name,
                  args,
                  signal,
                  toolCallId: `${ctx.toolCallId}${NESTED_CALL_MARKERS[COMPUTER_TOOL]}${index}`,
                  detached: false,
                  messages: ctx.messages,
                  onResult: (result) => {
                    const step = result.data?.["computer"]
                    if (isComputerStep(step)) steps.push(step)
                    for (const block of result.model_content ?? []) {
                      if (block.type === "image") {
                        media.push(block)
                        if (media.length > 4) media.shift()
                      }
                    }
                  }
                })
              }
            })
            effects.applied()
            const step = scriptStep(steps)
            return {
              result: JSON.stringify(value),
              preview: "Computer script completed",
              ...(step === undefined ? {} : { data: { computer: step } }),
              ...(media.length === 0 ? {} : { model_content: media })
            }
          } catch (cause) {
            if (session.kernel.closed) {
              sessions.delete(ctx.run.sessionId)
              await driver.stop()
            }
            throw cause
          }
        })
      }
    }),
    defineServerTool({
      name: "computer_reset",
      description:
        "Stop native control, invalidate all native observations, and discard this chat's persistent computer script state. Use for takeover or recovery. Other native calls are cancelled; browser control remains governed by its own Take control button.",
      parameters: Schema.toStandardSchemaV1(EmptySchema),
      metadata: {
        effect: "run_record",
        changes_state: true,
        target: "reported",
        action: "read",
        display_name: "Stop computer control",
        kind: "computer",
        source: "_computer",
        concurrency_group: null,
        destructive: false,
        idempotent: true,
        code_mode: false
      },
      execute: async (_, ctx, effects) => {
        await effects.target(
          appTarget({ objectId: "computer", title: "Stopped controlling the computer" })
        )
        sessions.get(ctx.run.sessionId)?.kernel.close()
        sessions.delete(ctx.run.sessionId)
        await driver.stop()
        effects.applied()
        return {
          result:
            "Native control stopped. Computer script state and native observations were discarded. Reacquire targets and observe before acting.",
          preview: "Computer control stopped"
        }
      }
    })
  ]
})
