import { errorMessage } from "@arden-hq/std/errors"
import { execFile } from "node:child_process"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { sleep } from "@arden-hq/std/sleep"
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Schema } from "effect"
import { closeMcpClient, connectMcpClient, makeMcpClient } from "../mcp/client.js"
import { McpStdioTransport } from "../mcp/transport.js"
import { KeyedSerialQueue } from "../mcp/serial.js"
import type { ComputerStatus, ComputerSetup } from "@arden-hq/protocol/computer"
import { nativeAppMetadata } from "./app-metadata.js"
import { NativeObservations } from "./contract.js"
import { currentMillis } from "../runtime/clock.js"
import { CUA_RELEASE } from "./release.js"
import { verifyCuaApp } from "./install.js"
import { permissionSessionState, permissionGrantState } from "./permissions.js"
import { appBundles, nativeCallRefusal, withoutOwnApps } from "./own-windows.js"

const executeFile = promisify(execFile)

interface DriverConnection {
  readonly app: string
  readonly client: ReturnType<typeof makeMcpClient>
  readonly transport: McpStdioTransport
  readonly directory: string
  readonly socket: string
  readonly binary: string
}

export class NativeDriver {
  readonly observations = new NativeObservations()
  readonly #queue = new KeyedSerialQueue()
  #connection: DriverConnection | undefined
  #epoch = new AbortController()
  #closed = false
  #idle: ReturnType<typeof setTimeout> | undefined
  #permissions: ComputerSetup["permissions"] = { kind: "idle" }
  #permissionJob: Promise<void> | undefined

  static readonly #BUNDLE_TTL_MS = 5_000
  readonly #bundles = new Map<number, { readonly bundle: string; readonly at: number }>()

  constructor(
    readonly resolveApp: (signal: AbortSignal) => Promise<string>,
    readonly ownPid?: number
  ) {}

  async maintain(operation: () => Promise<void>): Promise<boolean> {
    return this.#queue.run("desktop", async () => {
      if (this.#connection !== undefined || this.#closed) return false
      await operation()
      return true
    })
  }

  permissionStatus(): ComputerSetup["permissions"] {
    return this.#permissions
  }

  setupPermissions(): void {
    if (this.#permissionJob !== undefined || this.#closed) return
    if (this.#idle !== undefined) clearTimeout(this.#idle)
    this.#idle = undefined
    const signal = this.#epoch.signal
    this.#permissions = { kind: "running" }
    this.#permissionJob = (async () => {
      const app = await this.resolveApp(signal)
      await this.#queue.run("desktop", async () => {
        this.observations.clear()
        await this.#disconnect()
        try {
          const connection = await this.#connect(signal, app, true)
          const result = await connection.client.callTool(
            { name: "check_permissions", arguments: {} },
            CallToolResultSchema,
            { signal, timeout: 10_000 }
          )
          signal.throwIfAborted()
          this.#permissions = permissionGrantState(result)
        } finally {
          await this.#disconnect()
        }
      })
    })()
      .catch((cause: unknown) => {
        this.#permissions = signal.aborted
          ? { kind: "idle" }
          : {
              kind: "failed",
              message: errorMessage(cause)
            }
      })
      .finally(() => {
        this.#permissionJob = undefined
      })
  }

  #app: { pid: number; at: number; metadata: ComputerStatus["application"] } | undefined

  async application(pid: number, signal: AbortSignal): Promise<ComputerStatus["application"]> {
    if (this.#app?.pid === pid && currentMillis() - this.#app.at < 300_000)
      return this.#app.metadata
    const metadata = await nativeAppMetadata({ pid, signal })
    this.#app = { pid, at: currentMillis(), metadata }
    return metadata
  }

  async run<A>(
    signal: AbortSignal,
    operation: (
      call: (name: string, args: Readonly<Record<string, Schema.Json>>) => Promise<CallToolResult>
    ) => Promise<A>
  ): Promise<A> {
    const epoch = this.#epoch.signal
    const before = AbortSignal.any([signal, epoch])
    const app = this.#connection?.app ?? (await this.resolveApp(before))
    return this.#queue.run("desktop", async () => {
      const active = AbortSignal.any([signal, epoch])
      active.throwIfAborted()
      if (this.#closed) throw new Error("Computer control is closed")
      if (this.#idle !== undefined) clearTimeout(this.#idle)
      try {
        const connection = await this.#connect(active, app)
        active.throwIfAborted()
        const send = async (name: string, args: Readonly<Record<string, Schema.Json>>) => {
          const result = await connection.client.callTool(
            { name, arguments: args },
            CallToolResultSchema,
            {
              signal: active,
              timeout: 30_000
            }
          )
          active.throwIfAborted()
          return CallToolResultSchema.parse(result)
        }
        return await operation(async (name, args) => {
          try {
            active.throwIfAborted()
            const refusal = await this.#ownWindowRefusal(name, args, send)
            if (refusal !== undefined)
              return { isError: true, content: [{ type: "text", text: refusal }] }
            const result = await send(name, args)
            if (name !== "list_apps") return result
            this.#learnBundles(result)
            return withoutOwnApps(result, this.ownPid)
          } catch (cause) {
            this.observations.clear()
            await this.#disconnect()
            throw cause
          }
        })
      } finally {
        if (!this.#closed) {
          this.#idle = setTimeout(() => {
            void this.stop()
          }, 15 * 60_000)
          this.#idle.unref()
        }
      }
    })
  }

  #learnBundles(result: CallToolResult): void {
    const at = currentMillis()
    for (const [pid, bundle] of appBundles(result.structuredContent)) {
      this.#bundles.set(pid, { bundle, at })
    }
  }

  async #ownWindowRefusal(
    name: string,
    args: Readonly<Record<string, Schema.Json>>,
    send: (name: string, args: Readonly<Record<string, Schema.Json>>) => Promise<CallToolResult>
  ): Promise<string | undefined> {
    const known = (pid: number): string | undefined => {
      const entry = this.#bundles.get(pid)
      return entry !== undefined && currentMillis() - entry.at < NativeDriver.#BUNDLE_TTL_MS
        ? entry.bundle
        : undefined
    }
    const pid = args.pid
    if (typeof pid === "number" && name !== "list_apps" && known(pid) === undefined) {
      const listed = await send("list_apps", {})
      if (!listed.isError) this.#learnBundles(listed)
    }
    return nativeCallRefusal(args, this.ownPid, known)
  }

  async stop(): Promise<void> {
    if (this.#idle !== undefined) clearTimeout(this.#idle)
    this.#epoch.abort(new Error("Computer control stopped; reacquire targets and observe again"))
    this.observations.clear()
    await this.#queue.run("desktop", () => this.#disconnect())
    await this.#permissionJob
    this.#epoch = new AbortController()
  }

  async close(): Promise<void> {
    this.#closed = true
    await this.stop()
  }

  async #connect(
    signal: AbortSignal,
    appPath: string,
    permissions = false
  ): Promise<DriverConnection> {
    if (this.#connection !== undefined) return this.#connection
    if (process.platform !== "darwin") {
      throw new Error(
        "Native app control is available on macOS. See Settings → Permissions → Computer control for setup."
      )
    }
    const app = resolve(appPath)
    const binary = join(app, "Contents/MacOS/cua-driver")
    await access(binary).catch(() => {
      throw new Error(
        "The configured Cua helper is missing. Open Settings → Permissions to repair computer-use setup."
      )
    })
    if ((await verifyCuaApp({ app, signal })) !== CUA_RELEASE.version)
      throw new Error(`Computer use requires Cua Driver ${CUA_RELEASE.version}`)
    const directory = await mkdtemp(join(tmpdir(), "arden-cua-"))
    const socket = join(directory, "driver.sock")
    const client = makeMcpClient()
    const transport = new McpStdioTransport({
      executable: binary,
      args: ["mcp", "--embedded", "--socket", socket],
      cwd: directory,
      environment: { PATH: "/usr/bin:/bin", CUA_DRIVER_EMBEDDED: "1" },
      secretValues: []
    })
    const connection = { client, transport, directory, socket, binary, app }
    this.#connection = connection
    try {
      // LaunchServices keeps TCC attached to the verified Cua app identity.
      await executeFile(
        "/usr/bin/open",
        [
          "-n",
          // Cua's native permission panel is opt-in; only this user action may foreground it.
          ...(permissions ? ["--env", "CUA_DRIVER_RS_PERMISSIONS_PANEL=1"] : ["-g"]),
          "-a",
          app,
          "--args",
          "serve",
          "--socket",
          socket,
          "--pid-file",
          join(directory, "driver.pid"),
          ...(permissions ? [] : ["--no-permissions-gate"])
        ],
        { signal, timeout: 10_000 }
      )
      const deadline = currentMillis() + (permissions ? 5 * 60_000 : 10_000)
      let ready = false
      while (currentMillis() < deadline) {
        signal.throwIfAborted()
        const status = await executeFile(binary, ["status", "--socket", socket], {
          signal,
          timeout: 2_000
        }).then(
          () => true,
          () => false
        )
        if (status) {
          ready = true
          break
        }
        await sleep(100)
      }
      if (!ready)
        throw new Error(
          permissions
            ? "Permission setup did not finish. Use Set permissions to try again."
            : "The Cua helper did not start. Retry computer use."
        )
      await connectMcpClient(client, transport, 10_000)
      // Cua's animated overlay can use a full core until it hides. Keep feedback brief;
      // the PiP retains the last action without keeping the native overlay rendering.
      while (true) {
        signal.throwIfAborted()
        const session = await client.callTool(
          { name: "start_session", arguments: { cursor_motion: { idle_hide_ms: 1000 } } },
          CallToolResultSchema,
          { signal, timeout: 10_000 }
        )
        if (permissionSessionState(session) === "ready") return connection
        if (!permissions)
          throw new Error(
            "Complete permission setup in Settings → Permissions before computer use."
          )
        if (currentMillis() >= deadline)
          throw new Error("Permission setup did not finish. Use Set permissions to try again.")
        await sleep(1000, signal)
      }
    } catch (cause) {
      await this.#disconnect()
      throw cause
    }
  }

  async #disconnect(): Promise<void> {
    const connection = this.#connection
    this.#connection = undefined
    this.#bundles.clear()
    if (connection === undefined) return
    await closeMcpClient(connection)
    await executeFile(connection.binary, ["stop", "--socket", connection.socket], {
      timeout: 3_000
    }).catch(() => undefined)
    await rm(connection.directory, { recursive: true, force: true })
  }
}
