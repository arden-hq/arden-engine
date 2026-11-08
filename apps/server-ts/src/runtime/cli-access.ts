import { CLI_ACCESS_FILE, daemonDecoders, type CliAccess } from "@arden-hq/protocol/daemon"
import { readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { writeAtomic } from "@arden-hq/std/atomic-file"

export const cliAccessPath = (databasePath: string): string =>
  join(dirname(databasePath), CLI_ACCESS_FILE)

export const publishCliAccess = async (path: string, access: CliAccess): Promise<void> => {
  await writeAtomic(path, `${JSON.stringify(access)}\n`)
}

export const withdrawCliAccess = async (path: string, capability: string): Promise<void> => {
  let current: CliAccess
  try {
    current = daemonDecoders.cliAccess(JSON.parse(await readFile(path, "utf8")))
  } catch {
    return
  }
  if (current.capability === capability) await rm(path, { force: true })
}
