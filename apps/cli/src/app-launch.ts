import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

export type InstalledApp =
  | { readonly kind: "background"; readonly path: string }
  | { readonly kind: "too_old"; readonly path: string }

export interface AppLauncher {
  readonly find: () => Promise<InstalledApp | undefined>
  readonly open: (appPath: string) => Promise<void>
  readonly pollMs: number
  readonly timeoutMs: number
}

const BUNDLE_ID = "com.arden.desktop"
const DEFAULT_PATH = "/Applications/Arden.app"
const BACKGROUND_KEY = "ArdenBackgroundLaunch"

const run = promisify(execFile)

export const installedAppAt = async (path: string): Promise<InstalledApp> => {
  const declared = await run("plutil", [
    "-extract",
    BACKGROUND_KEY,
    "raw",
    join(path, "Contents", "Info.plist")
  ]).catch(() => undefined)
  const value = declared?.stdout.trim()
  return value === "1" || value === "true"
    ? { kind: "background", path }
    : { kind: "too_old", path }
}

const bundlePath = async (): Promise<string | undefined> => {
  if (process.platform !== "darwin") return undefined
  if (existsSync(DEFAULT_PATH)) return DEFAULT_PATH
  const found = await run("mdfind", [`kMDItemCFBundleIdentifier == '${BUNDLE_ID}'`]).catch(
    () => undefined
  )
  const first = found?.stdout.split("\n").find((line) => line.endsWith(".app"))
  return first === undefined || first === "" ? undefined : first
}

export const macAppLauncher: AppLauncher = {
  find: async () => {
    const path = await bundlePath()
    return path === undefined ? undefined : installedAppAt(path)
  },
  open: async (appPath) => {
    await run("open", ["-g", "-a", appPath, "--args", "--background"])
  },
  pollMs: 200,
  timeoutMs: 30_000
}
