import { access, rm, writeFile } from "node:fs/promises"
import { Context, Effect, Layer, Schema } from "effect"
import { NativeDriver } from "./driver.js"
import { ComputerControl } from "./control.js"
import { KeyedSerialQueue } from "../mcp/serial.js"
import { CuaSetup } from "./setup.js"
import type { ComputerSetup } from "@arden-hq/protocol/computer"

const desktopPid = (): number | undefined => {
  const pid = Number(process.env.ARDEN_DESKTOP_PROCESS_PID)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

export class ComputerService extends Context.Service<
  ComputerService,
  {
    readonly driver: NativeDriver
    readonly control: ComputerControl
    readonly setup: CuaSetup
    readonly setupStatus: () => ComputerSetup
    readonly permissions: () => void
    readonly pause: () => Promise<void>
    readonly resume: () => Promise<void>
  }
>()("arden/computer/ComputerService") {
  static readonly layer = (options: { readonly pauseFile: string; readonly installRoot: string }) =>
    Layer.effect(
      ComputerService,
      Effect.gen(function* () {
        const driver: NativeDriver = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new NativeDriver(async (signal): Promise<string> => {
                await initialized
                return setup.app(signal)
              }, desktopPid())
          ),
          (driver) => Effect.promise(() => driver.close())
        )
        const setup: CuaSetup = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new CuaSetup({
                root: options.installRoot,
                maintain: (operation) => driver.maintain(operation)
              })
          ),
          (setup) => Effect.promise(() => setup.close())
        )
        const initialized: Promise<void> = setup.initialize()
        yield* Effect.forkScoped(Effect.promise(() => initialized))
        const pauseFile = options.pauseFile
        const control = new ComputerControl()
        const paused = yield* Effect.promise(() =>
          access(pauseFile).then(
            () => true,
            (cause: unknown) => !Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(cause)
          )
        )
        if (paused) control.pause()
        const queue = new KeyedSerialQueue()
        let revision = 0
        return ComputerService.of({
          driver,
          control,
          setup,
          setupStatus: () => ({ ...setup.status(), permissions: driver.permissionStatus() }),
          permissions: () => driver.setupPermissions(),
          pause: () => {
            revision++
            control.pause()
            return queue.run("takeover", async () => {
              try {
                await writeFile(pauseFile, "paused\n", { mode: 0o600 })
              } finally {
                await driver.stop()
              }
            })
          },
          resume: () => {
            const requested = ++revision
            return queue.run("takeover", async () => {
              await rm(pauseFile, { force: true })
              if (requested === revision) control.resume()
            })
          }
        })
      })
    )
}
