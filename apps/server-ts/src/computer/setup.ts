import { errorMessage } from "@arden-hq/std/errors"
import { access, mkdir, readdir, rm, statfs, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { sleep } from "@arden-hq/std/sleep"
import { Effect } from "effect"
import { lock } from "proper-lockfile"
import type { ComputerSetup } from "@arden-hq/protocol/computer"
import { downloadFile } from "../lib/download.js"
import {
  cuaAppIsRunning,
  promoteCuaApp,
  preserveCuaNotices,
  recoverCuaApp,
  stageCuaApp,
  verifyCuaApp
} from "./install.js"
import { CUA_RELEASE } from "./release.js"

export class CuaSetup {
  #installation: ComputerSetup["installation"] = { kind: "disabled" }
  #operation: Promise<void> | undefined
  #controller: AbortController | undefined
  #available = false
  #closed = false

  constructor(
    readonly options: {
      readonly root: string
      readonly maintain: (operation: () => Promise<void>) => Promise<boolean>
    }
  ) {
    if (process.platform !== "darwin") this.#installation = { kind: "unsupported" }
  }

  status(): ComputerSetup {
    return {
      version: CUA_RELEASE.version,
      installation: this.#installation,
      permissions: { kind: "idle" }
    }
  }

  async initialize(): Promise<void> {
    if (this.#installation.kind === "unsupported") return
    this.#installation = { kind: "verifying" }
    const enabled = await access(join(this.options.root, "enabled")).then(
      () => true,
      () => false
    )
    if (enabled && !this.#closed) await this.start()
    else if (this.#operation === undefined) this.#installation = { kind: "disabled" }
  }

  async start(): Promise<ComputerSetup> {
    if (this.#closed || this.#operation !== undefined || this.#installation.kind === "unsupported")
      return this.status()
    const controller = new AbortController()
    this.#controller = controller
    this.#installation = { kind: "verifying" }
    this.#operation = (async () => {
      await mkdir(this.options.root, { recursive: true, mode: 0o700 })
      controller.signal.throwIfAborted()
      await writeFile(join(this.options.root, "enabled"), "enabled\n", { mode: 0o600 })
      let release: (() => Promise<void>) | undefined
      while (release === undefined) {
        controller.signal.throwIfAborted()
        try {
          release = await lock(join(this.options.root, "installation"), {
            realpath: false,
            onCompromised: (error) => {
              this.#installation = { kind: "failed", message: error.message }
              controller.abort(error)
            }
          })
        } catch (cause) {
          if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ELOCKED")
            throw cause
          this.#installation = { kind: "waiting" }
          await sleep(5000, controller.signal)
        }
      }
      try {
        await this.#install(controller.signal)
      } finally {
        await release()
      }
    })()
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          this.#installation = {
            kind: "failed",
            message: errorMessage(cause)
          }
        }
      })
      .finally(() => {
        this.#operation = undefined
        this.#controller = undefined
      })
    return this.status()
  }

  async stop(): Promise<ComputerSetup> {
    this.#controller?.abort()
    await this.#operation
    await rm(join(this.options.root, "enabled"), { force: true })
    this.#installation = this.#available ? { kind: "installed" } : { kind: "disabled" }
    return this.status()
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#controller?.abort()
    await this.#operation
  }

  async app(signal: AbortSignal): Promise<string> {
    if (this.#installation.kind === "unsupported")
      throw new Error("Native app control is available on macOS.")
    if (!this.#available && this.#operation !== undefined) {
      let abort: () => void = () => {}
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      })
      try {
        await Promise.race([this.#operation, cancelled])
      } finally {
        signal.removeEventListener("abort", abort)
      }
    }
    signal.throwIfAborted()
    if (!this.#available) {
      const state = this.#installation
      throw new Error(
        state.kind === "failed"
          ? state.message
          : "Enable computer use in Settings → Permissions. Arden downloads and verifies its native helper."
      )
    }
    return join(this.options.root, "CuaDriver.app")
  }

  async #install(signal: AbortSignal): Promise<void> {
    const app = join(this.options.root, "CuaDriver.app")
    const recovery = await access(join(this.options.root, "CuaDriver.previous.app")).then(
      () => true,
      () => false
    )
    if (recovery) {
      await this.#idle(
        () =>
          recoverCuaApp({
            root: this.options.root,
            verify: async (candidate) => {
              await verifyCuaApp({ app: candidate, signal })
            }
          }),
        signal
      )
    }
    for (const entry of await readdir(this.options.root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(".staging-")) {
        await rm(join(this.options.root, entry.name), { recursive: true, force: true })
      }
    }
    const current = await verifyCuaApp({ app, signal }).catch(() => undefined)
    signal.throwIfAborted()
    if (current === CUA_RELEASE.version) {
      await rm(join(this.options.root, "CuaDriver.previous.app"), { recursive: true, force: true })
      this.#available = true
      this.#installation = { kind: "installed" }
      await rm(join(this.options.root, CUA_RELEASE.artifact.path), { force: true })
      await rm(join(this.options.root, `${CUA_RELEASE.artifact.path}.partial`), { force: true })
      return
    }
    this.#available = false
    const disk = await statfs(this.options.root)
    const needed = CUA_RELEASE.artifact.bytes + CUA_RELEASE.expandedBytes + 1024 * 1024 * 1024
    if (disk.bavail * disk.bsize < needed)
      throw new Error(
        "Not enough free disk space to install the native helper. Free some space, then retry."
      )
    const archive = join(this.options.root, CUA_RELEASE.artifact.path)
    this.#installation = {
      kind: "downloading",
      receivedBytes: 0,
      totalBytes: CUA_RELEASE.artifact.bytes
    }
    await Effect.runPromise(
      downloadFile({
        file: CUA_RELEASE.artifact,
        destination: archive,
        fetch: globalThis.fetch,
        onBytes: (receivedBytes) => {
          this.#installation = {
            kind: "downloading",
            receivedBytes,
            totalBytes: CUA_RELEASE.artifact.bytes
          }
        }
      }),
      { signal }
    )
    this.#installation = { kind: "verifying" }
    const staged = await stageCuaApp({ root: this.options.root, archive, signal })
    try {
      await preserveCuaNotices({ root: this.options.root, stagedDirectory: staged.directory })
      await this.#idle(
        () =>
          promoteCuaApp({
            root: this.options.root,
            stagedApp: staged.app,
            verify: async (candidate) => {
              const version = await verifyCuaApp({
                app: candidate,
                signal: new AbortController().signal
              })
              if (version !== CUA_RELEASE.version)
                throw new Error("Installed Cua version did not match")
            }
          }),
        signal
      )
      this.#available = true
      this.#installation = { kind: "installed" }
      await rm(archive, { force: true })
    } finally {
      await rm(staged.directory, { recursive: true, force: true })
    }
  }

  async #idle(operation: () => Promise<void>, signal: AbortSignal): Promise<void> {
    while (true) {
      signal.throwIfAborted()
      const running = await cuaAppIsRunning(join(this.options.root, "CuaDriver.app"))
      if (!running && (await this.options.maintain(operation))) return
      this.#installation = { kind: "waiting" }
      await sleep(5000, signal)
    }
  }
}
