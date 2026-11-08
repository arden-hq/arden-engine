import { clipLine } from "@arden-hq/std/text"
import { daemonHandshake, type CliAccess, type OperationalEvent } from "@arden-hq/protocol/daemon"
import { DaemonClientHandshakeSchema } from "@arden-hq/protocol/daemon/effect"
import { Schema } from "effect"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createBrowserBrokerBridge } from "./browser/bridge.js"
import { cliAccessPath, publishCliAccess, withdrawCliAccess } from "./runtime/cli-access.js"
import { createCredentialVaultBridge } from "./daemon-credential-vault.js"
import { brokeredProviderRoute, type BrokerCredential } from "./providers/registry.js"
import { createParentPortRpc, type ParentPortFailure } from "./runtime/parent-port-rpc.js"
import { mergePath, resolveLoginShellPath } from "./runtime/login-shell-path.js"
import { resolveCommandSandbox } from "./runtime/command-sandbox.js"
import { ServerError, startServerWithLocalAccess, type ServerHandle } from "./server.js"
import type { ModelProviderOptions, PowerHost } from "./config/options.js"
import type { MigrationProgress } from "./runtime/diagnostics.js"
import type { StartupPhase } from "./runtime/startup-phase.js"
import { errorMessage } from "@arden-hq/std/errors"

const CREDENTIAL_REQUEST_TIMEOUT_MS = 35_000

const LLAMA_SERVER =
  process.env.ARDEN_LLAMA_SERVER ?? fileURLToPath(new URL("./llama/llama-server", import.meta.url))

interface ParentPort {
  readonly on: (event: "message", listener: (event: { readonly data: unknown }) => void) => void
  readonly postMessage: (message: unknown) => void
}

const StartMessageSchema = Schema.Struct({
  type: Schema.Literal("start"),
  options: Schema.Struct({
    hostname: Schema.Literal("127.0.0.1"),
    port: Schema.Literal(0),
    version: Schema.String.check(Schema.isMinLength(1)),
    databasePath: Schema.String.check(Schema.isMinLength(1)),
    rendererOrigin: Schema.String.check(Schema.isMinLength(1)),
    handshake: DaemonClientHandshakeSchema,
    sharedSkillRoots: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
    googleOAuthClient: Schema.optionalKey(
      Schema.Struct({
        clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
        clientSecret: Schema.optionalKey(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
        )
      })
    )
  }),
  capability: Schema.String.check(Schema.isMinLength(32))
})

const StopMessageSchema = Schema.Struct({
  type: Schema.Literal("stop"),
  reason: Schema.optionalKey(Schema.Literals(["quit", "restart"])),
  budgetMs: Schema.optionalKey(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
  )
})
const CredentialChangedMessageSchema = Schema.Struct({ type: Schema.Literal("credential_changed") })
const CredentialResponseSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("credential_response"),
    requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    ok: Schema.Literal(true),
    credential: Schema.NullOr(
      Schema.Struct({
        accessToken: Schema.String.check(Schema.isMinLength(1)),
        accountId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1)))
      })
    )
  }),
  Schema.Struct({
    type: Schema.Literal("credential_response"),
    requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    ok: Schema.Literal(false)
  })
])
const SystemSleepMessageSchema = Schema.Struct({
  type: Schema.Literal("system_sleep"),
  asleep: Schema.Boolean
})
type StopReason = NonNullable<(typeof StopMessageSchema.Type)["reason"]>
const decodeStartMessage = Schema.decodeUnknownSync(StartMessageSchema)
const isStopMessage = Schema.is(StopMessageSchema)
const isCredentialChangedMessage = Schema.is(CredentialChangedMessageSchema)
const isCredentialResponse = Schema.is(CredentialResponseSchema)
const isSystemSleepMessage = Schema.is(SystemSleepMessageSchema)

const cancelledCredentialRequest = (): DOMException =>
  new DOMException("The credential request was cancelled", "AbortError")

const credentialFailure = (failure: ParentPortFailure<undefined>): unknown => {
  switch (failure.kind) {
    case "aborted":
      return failure.reason ?? cancelledCredentialRequest()
    case "stopped":
      return cancelledCredentialRequest()
    case "timeout":
      return new Error("The credential broker timed out")
    case "dispatch_failed":
      return failure.cause
    case "invalid_response":
    case "rejected":
      return new Error("The credential broker failed")
  }
}

const parentPort = (process as unknown as { readonly parentPort?: ParentPort }).parentPort

if (parentPort === undefined) {
  throw new Error("The Arden daemon must run as an Electron utility process")
}

// Launched from the Dock, the app inherits launchd's bare PATH. Ask the login
// shell once, beside the boot and never in its way; agent terminals use it
// once it lands, and the host's terminal drawer gets it in a message.
void resolveLoginShellPath().then((loginPath) => {
  if (loginPath === undefined) return
  try {
    parentPort.postMessage({
      type: "login_path",
      path: mergePath(loginPath, process.env["PATH"])
    })
  } catch {
    // The host may be gone; its terminals keep the inherited PATH.
  }
})

void resolveCommandSandbox()

const browserBridge = createBrowserBrokerBridge(parentPort)
const credentialVaultBridge = createCredentialVaultBridge(parentPort)

const sleepListeners = new Set<(asleep: boolean) => void>()
const power: PowerHost = {
  keepAwake: (hold) => {
    try {
      parentPort.postMessage({ type: "keep_awake", hold })
    } catch {
      // The host may be gone; a stopped daemon holds nothing.
    }
  },
  onSleep: (listener) => {
    sleepListeners.add(listener)
    return () => sleepListeners.delete(listener)
  }
}

let server: ServerHandle | undefined
let appVersion: string | undefined
let lifecycle: Promise<void> = Promise.resolve()
let exiting = false
let stopRequested = false
let cliAccess: { readonly path: string; readonly capability: string } | undefined

const credentialRpc = createParentPortRpc<BrokerCredential | null, undefined>(parentPort, {
  type: "credential_request",
  timeoutMs: CREDENTIAL_REQUEST_TIMEOUT_MS,
  decode: (input) => {
    if (!isCredentialResponse(input)) return undefined
    return input.ok
      ? { kind: "value", requestId: input.requestId, value: input.credential }
      : { kind: "error", requestId: input.requestId, error: undefined }
  }
})

const requestCredential = (
  forceRefresh: boolean,
  signal: AbortSignal
): Promise<BrokerCredential | null> =>
  stopRequested
    ? Promise.reject(signal.reason ?? cancelledCredentialRequest())
    : credentialRpc.request({ forceRefresh }, { signal, fail: credentialFailure })

const postOperationalEvent = (event: OperationalEvent): void => {
  parentPort.postMessage({ type: "operational_event", event })
}

const stop = async (reason: StopReason, budgetMs = 5_500): Promise<void> => {
  credentialRpc.abortAll()
  browserBridge.close()
  credentialVaultBridge.close()
  const published = cliAccess
  cliAccess = undefined
  const withdrawn =
    published === undefined
      ? Promise.resolve()
      : withdrawCliAccess(published.path, published.capability).catch(() => undefined)
  if (server === undefined) return withdrawn
  const current = server
  server = undefined
  await Promise.all([withdrawn, current.stop({ reason, budgetMs })])
}

const exit = (code: number): void => {
  if (exiting) return
  exiting = true
  process.exitCode = code
  setImmediate(() => process.exit(code))
}

const start = async (input: unknown): Promise<void> => {
  if (server !== undefined) {
    parentPort.postMessage({ type: "error", code: "invalid_start" })
    return
  }

  let message: typeof StartMessageSchema.Type
  try {
    message = decodeStartMessage(input)
  } catch {
    parentPort.postMessage({ type: "error", code: "invalid_start" })
    exit(1)
    return
  }

  try {
    if (stopRequested) return
    const startedAt = performance.now()
    const serverOptions = {
      hostname: message.options.hostname,
      port: message.options.port,
      version: message.options.version,
      databasePath: message.options.databasePath,
      llamaServer: LLAMA_SERVER,
      ...(message.options.sharedSkillRoots === undefined
        ? {}
        : { sharedSkillRoots: message.options.sharedSkillRoots }),
      googleOAuthClient: message.options.googleOAuthClient,
      credentialVault: credentialVaultBridge.vault
    }
    const cliCapability = randomBytes(32).toString("base64url")
    const localAccess = {
      capability: message.capability,
      rendererOrigin: message.options.rendererOrigin,
      cliCapability
    }
    const startupSignal = new AbortController().signal
    const initial = await requestCredential(false, startupSignal).catch(() => null)
    if (stopRequested) return
    const route = initial === null ? "local_only" : brokeredProviderRoute.id
    const reportedPhases = new Set<StartupPhase>()
    const reportPhase = (phase: StartupPhase): void => {
      if (reportedPhases.has(phase)) return
      reportedPhases.add(phase)
      try {
        parentPort.postMessage({
          type: "startup_phase",
          phase,
          route,
          elapsedMs: Math.round(performance.now() - startedAt)
        })
      } catch {
        // Diagnostics cannot prevent startup or recovery.
      }
    }
    const reportMigration = (progress: MigrationProgress): void => {
      try {
        parentPort.postMessage({
          type: "startup_phase",
          phase: "schema_migration",
          route,
          elapsedMs: Math.round(performance.now() - startedAt),
          migration: progress
        })
      } catch {
        // Diagnostics cannot prevent startup or recovery.
      }
    }
    reportPhase("server_open_started")
    const diagnostics = {
      startupPhase: reportPhase,
      migration: reportMigration,
      operational: postOperationalEvent
    }
    const provider = providerFor(initial, message.options.version)
    if (stopRequested) return
    server = await startServerWithLocalAccess({
      ...serverOptions,
      ...provider,
      diagnostics,
      localAccess,
      browserBroker: browserBridge,
      power
    })
    if (stopRequested) return
    appVersion = message.options.version
    parentPort.postMessage({
      type: "ready",
      appVersion: message.options.version,
      ...daemonHandshake,
      hostname: "127.0.0.1",
      port: server.port,
      serverUrl: server.url.href
    })
    const path = cliAccessPath(message.options.databasePath)
    const access: CliAccess = {
      version: 1,
      serverUrl: server.url.href,
      capability: cliCapability,
      pid: process.pid
    }
    const published = await publishCliAccess(path, access).then(
      () => true,
      () => false
    )
    if (published && stopRequested) {
      await withdrawCliAccess(path, cliCapability).catch(() => undefined)
    } else if (published) {
      cliAccess = { path, capability: cliCapability }
    }
  } catch (cause) {
    if (stopRequested) return
    const detail = diagnosticDetail(cause)
    if (
      cause instanceof ServerError &&
      (cause.code === "storage_failed" ||
        cause.code === "data_newer" ||
        cause.code === "schema_convert_failed")
    ) {
      parentPort.postMessage({
        type: "error",
        code: cause.code,
        detail
      })
      exit(1)
      return
    }
    parentPort.postMessage({ type: "error", code: "start_failed", detail })
    exit(1)
  }
}

const providerFor = (credential: BrokerCredential | null, version: string): ModelProviderOptions =>
  credential === null
    ? {}
    : brokeredProviderRoute.start({ initial: credential, request: requestCredential }, version)

const replaceProvider = async (): Promise<void> => {
  const current = server
  const version = appVersion
  if (current === undefined || version === undefined || stopRequested) return
  const credential = await requestCredential(false, new AbortController().signal).catch(() => null)
  if (stopRequested) return
  const route = credential === null ? "local_only" : brokeredProviderRoute.id
  try {
    await current.replaceProvider(providerFor(credential, version))
    parentPort.postMessage({ type: "provider_changed", route })
  } catch (cause) {
    parentPort.postMessage({
      type: "provider_change_failed",
      route,
      detail: diagnosticDetail(cause)
    })
  }
}

const diagnosticDetail = (cause: unknown): string =>
  clipLine(errorMessage(cause).replace(/[\u0000-\u001f\u007f]+/g, " "), 500)

const handleMessage = async (input: unknown): Promise<void> => {
  if (isStopMessage(input)) {
    try {
      await stop(input.reason ?? "quit", input.budgetMs)
      parentPort.postMessage({ type: "stopped" })
      exit(0)
    } catch {
      parentPort.postMessage({ type: "error", code: "stop_failed" })
      exit(1)
    }
    return
  }
  if (isCredentialChangedMessage(input)) {
    await replaceProvider()
    return
  }

  await start(input)
}

parentPort.on("message", (event) => {
  if (browserBridge.handleMessage(event.data)) return
  if (credentialVaultBridge.handleMessage(event.data)) return
  if (credentialRpc.handleMessage(event.data)) return
  if (isSystemSleepMessage(event.data)) {
    const { asleep } = event.data
    for (const listener of sleepListeners) listener(asleep)
    return
  }
  if (isStopMessage(event.data)) {
    stopRequested = true
    credentialRpc.abortAll()
  }
  lifecycle = lifecycle.then(() => handleMessage(event.data)).catch(() => exit(1))
})

const handleSignal = (): void => {
  stopRequested = true
  credentialRpc.abortAll()
  void stop("quit").then(
    () => exit(0),
    () => exit(1)
  )
}

process.once("SIGINT", handleSignal)
process.once("SIGTERM", handleSignal)
