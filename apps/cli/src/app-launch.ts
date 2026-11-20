import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { promisify } from "node:util"

export interface AppLauncher {
  readonly find: () => Promise<string | undefined>
  readonly open: (appPath: string) => Promise<void>
  readonly pollMs: number
  readonly timeoutMs: number
}

const BUNDLE_ID = "com.arden.desktop"
const DEFAULT_PATH = "/Applications/Arden.app"

const run = promisify(execFile)

export const macAppLauncher: AppLauncher = {
  find: async () => {
    if (process.platform !== "darwin") return undefined
    if (existsSync(DEFAULT_PATH)) return DEFAULT_PATH
    const found = await run("mdfind", [`kMDItemCFBundleIdentifier == '${BUNDLE_ID}'`]).catch(
      () => undefined
    )
    const first = found?.stdout.split("\n").find((line) => line.endsWith(".app"))
    return first === undefined || first === "" ? undefined : first
  },
  open: async (appPath) => {
    await run("open", ["-g", "-a", appPath, "--args", "--background"])
  },
  pollMs: 200,
  timeoutMs: 30_000
}
