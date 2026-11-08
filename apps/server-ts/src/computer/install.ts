import { execFile } from "node:child_process"
import { access, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { Schema } from "effect"
import { CUA_RELEASE } from "./release.js"

const execute = promisify(execFile)
const Manifest = Schema.Struct({ binary_version: Schema.String })

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  )

export async function cuaAppIsRunning(app: string): Promise<boolean> {
  const processes = await execute("/bin/ps", ["-ax", "-o", "comm="], { timeout: 5000 })
  return processes.stdout
    .split("\n")
    .some((line) => line.trim().startsWith(`${app}/Contents/MacOS/`))
}

export async function verifyCuaApp(options: {
  readonly app: string
  readonly signal: AbortSignal
}): Promise<string> {
  const { app, signal } = options
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
    signal,
    timeout: 10_000
  })
  const signature = await execute("/usr/bin/codesign", ["-dv", app], { signal, timeout: 10_000 })
  if (
    !signature.stderr.includes("Identifier=com.trycua.driver\n") ||
    !["4YEC26S9KF", "YCK386LBJ7"].some((team) =>
      signature.stderr.includes(`TeamIdentifier=${team}\n`)
    )
  ) {
    throw new Error("Cua Driver signing identity does not match the supported release")
  }
  await execute("/usr/sbin/spctl", ["--assess", "--type", "execute", app], {
    signal,
    timeout: 30_000
  })
  const manifest = await execute(join(app, "Contents/MacOS/cua-driver"), ["manifest"], {
    signal,
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024
  })
  const raw: unknown = JSON.parse(manifest.stdout)
  return Schema.decodeUnknownSync(Manifest)(raw).binary_version
}

export async function recoverCuaApp(options: {
  readonly root: string
  readonly verify: (app: string) => Promise<void>
}): Promise<void> {
  const root = options.root
  const app = join(root, "CuaDriver.app")
  const backup = join(root, "CuaDriver.previous.app")
  if (!(await exists(backup))) return
  if (await exists(app)) {
    const valid = await options.verify(app).then(
      () => true,
      () => false
    )
    if (valid) {
      await rm(backup, { recursive: true, force: true })
      return
    }
  }
  await options.verify(backup)
  await rm(app, { recursive: true, force: true })
  await rename(backup, app)
}

export async function promoteCuaApp(options: {
  readonly root: string
  readonly stagedApp: string
  readonly verify: (app: string) => Promise<void>
}): Promise<void> {
  const app = join(options.root, "CuaDriver.app")
  const backup = join(options.root, "CuaDriver.previous.app")
  if (await exists(backup)) throw new Error("A previous Cua installation needs recovery")
  const previous = await exists(app)
  if (previous) await rename(app, backup)
  try {
    await rename(options.stagedApp, app)
    await options.verify(app)
  } catch (cause) {
    await rm(app, { recursive: true, force: true })
    if (previous) await rename(backup, app)
    throw cause
  }
  await rm(backup, { recursive: true, force: true })
}

export async function stageCuaApp(options: {
  readonly root: string
  readonly archive: string
  readonly signal: AbortSignal
}): Promise<{ readonly app: string; readonly directory: string }> {
  await mkdir(options.root, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(options.root, ".staging-"))
  try {
    const entries = await execute("/usr/bin/tar", ["-tzf", options.archive], {
      signal: options.signal,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024
    })
    if (
      !entries.stdout
        .trim()
        .split("\n")
        .every(
          (entry) =>
            (entry === CUA_RELEASE.directory || entry.startsWith(`${CUA_RELEASE.directory}/`)) &&
            !entry.split("/").some((part) => part === "..")
        )
    ) {
      throw new Error("Cua archive contains an unexpected installation path")
    }
    await execute(
      "/usr/bin/tar",
      [
        "-xzf",
        options.archive,
        "--no-same-owner",
        "--no-same-permissions",
        "--safe-writes",
        "-C",
        directory
      ],
      {
        signal: options.signal,
        timeout: 30_000
      }
    )
    const app = join(directory, CUA_RELEASE.directory, "CuaDriver.app")
    const version = await verifyCuaApp({ app, signal: options.signal })
    if (version !== CUA_RELEASE.version)
      throw new Error("Cua archive has an unexpected driver version")
    return { app, directory }
  } catch (cause) {
    await rm(directory, { recursive: true, force: true })
    throw cause
  }
}

/** Keep the upstream notices outside the signed bundle so its seal is unchanged. */
export async function preserveCuaNotices(options: {
  readonly root: string
  readonly stagedDirectory: string
}): Promise<void> {
  const destination = join(options.root, "notices", CUA_RELEASE.version)
  await mkdir(destination, { recursive: true })
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    await copyFile(
      join(options.stagedDirectory, CUA_RELEASE.directory, file),
      join(destination, file)
    )
  }
}
