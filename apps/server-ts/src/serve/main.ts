import { CONFIGURED_SERVER_EXIT } from "@arden-hq/protocol/daemon"
import { errorMessage } from "@arden-hq/std/errors"
import { ProviderUnreachableError } from "./models.js"
import { readSettings, SettingsError } from "./settings.js"
import { readyLine, startConfigured, type StartedServer, type StartServer } from "./serve.js"

/**
 * The process behind `--config <file>`. On stdout it prints one JSON line when
 * the server is ready (`readyLine`), then nothing; it runs until SIGINT or
 * SIGTERM. A start that fails writes the reason on stderr and exits with
 * `CONFIGURED_SERVER_EXIT`: a settings mistake, a model server that did not
 * answer; any other failure exits 1.
 */
export const runConfigured = async (
  file: string | undefined,
  start: StartServer<StartedServer>
): Promise<void> => {
  // Stdout carries the ready line and nothing else, so a driver can read it
  // as JSON. The server's log lines, which the logger writes with
  // console.log, go to stderr instead.
  console.log = console.error.bind(console)
  console.info = console.error.bind(console)
  try {
    if (file === undefined) throw new SettingsError("Usage: --config <settings file>")
    const settings = await readSettings(file)
    // A signal during the start is kept and acted on once there is a server
    // to stop, so the access file and the database are always left clean.
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
