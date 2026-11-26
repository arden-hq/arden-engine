import { CONFIGURED_SERVER_EXIT } from "@arden-hq/protocol/daemon"
import { errorMessage } from "@arden-hq/std/errors"
import { ProviderUnreachableError } from "./models.js"
import { readSettings, SettingsError } from "./settings.js"
import { readyLine, startConfigured, type StartedServer, type StartServer } from "./serve.js"

export const runConfigured = async (
  file: string | undefined,
  start: StartServer<StartedServer>
): Promise<void> => {
  console.log = console.error.bind(console)
  console.info = console.error.bind(console)
  try {
    if (file === undefined) throw new SettingsError("Usage: --config <settings file>")
    const settings = await readSettings(file)
    let wanted = false
    let stop = (): void => {
      wanted = true
    }
    const onSignal = (): void => stop()
    process.on("SIGINT", onSignal)
    process.on("SIGTERM", onSignal)
    const configured = await startConfigured(settings, start)
    let stopping = false
    stop = (): void => {
      if (stopping) return
      stopping = true
      void configured.stop().then(
        () => process.exit(0),
        () => process.exit(1)
      )
    }
    if (wanted) return stop()
    process.stdout.write(`${JSON.stringify(readyLine(configured))}\n`)
  } catch (cause) {
    process.stderr.write(`arden: ${errorMessage(cause)}\n`)
    process.exit(exitCodeOf(cause))
  }
}

const exitCodeOf = (cause: unknown): number => {
  if (cause instanceof SettingsError) return CONFIGURED_SERVER_EXIT.settings
  if (cause instanceof ProviderUnreachableError) return CONFIGURED_SERVER_EXIT.providerUnreachable
  return 1
}
