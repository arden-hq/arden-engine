import { abortAfter } from "@arden-hq/std/timer"
import { latestChats, oneSession } from "./session-list.js"
import { newChat, wholeFork } from "./session-requests.js"
import { receiptFromRun, type ReceiptResult, type ReceiptRun } from "./run-receipt-detail.js"
import { nameText, runIsActive, spaceIdOf } from "@arden-hq/protocol/sessions"
import {
  HeadlessHttpError,
  HeadlessTimeoutError,
  type HeadlessRunEvent,
  type RunDetail,
  type SubmittedRun
} from "@arden-hq/headless"
import {
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatApprovalMode,
  type ChatImageInput,
  type ChatMessageInput
} from "@arden-hq/protocol/chat"
import { CONFIGURED_SERVER_EXIT } from "@arden-hq/protocol/daemon"
import { extname } from "node:path"

import {
  createCliClient,
  NoModelError,
  OlderServerError,
  plainHttpMessage,
  resolveServer,
  ProviderUnavailableError,
  ServerUnavailableError,
  UsageError,
  type CliClient,
  type CliDependencies
} from "./command.js"
import { errorMessage } from "@arden-hq/std/errors"
import { progressLines, requestResponder, type RunResponder } from "./terminal.js"
import { parseJsonText } from "@arden-hq/std/json-text"

export type CliOutputFormat = "text" | "json" | "jsonl"

export type ApprovalHandling = "wait" | "decline" | "ask_then_decline"

export type SessionTarget =
  | { readonly kind: "new"; readonly space: string | undefined; readonly model: string | undefined }
  | { readonly kind: "existing"; readonly sessionId: string }
  | { readonly kind: "latest" }
  | { readonly kind: "fork"; readonly sessionId: string }

export interface RunOptions {
  readonly promptArgument: string | undefined
  readonly urlArgument: string | undefined
  readonly target: SessionTarget
  readonly imagePaths: ReadonlyArray<string>
  readonly outputSchemaPath: string | undefined
  readonly approvalMode: ChatApprovalMode
  readonly approvals: ApprovalHandling
  readonly output: CliOutputFormat
  readonly timeoutMs: number | undefined
  readonly detach: boolean
}

export interface WaitOptions {
  readonly runId: string
  readonly urlArgument: string | undefined
  readonly approvals: ApprovalHandling
  readonly output: CliOutputFormat
  readonly timeoutMs: number | undefined
}

export interface CommandReceiptError {
  readonly code: string
  readonly message: string
}

export interface DeclinedRequest {
  readonly kind: "approval" | "connection"
  readonly tool_id: string
  readonly name: string
}

export interface CommandReceiptV1 {
  readonly version: 1
  readonly type: "command_receipt"
  readonly command: "run" | "wait"
  readonly status: "completed" | "submitted" | "failed" | "cancelled" | "interrupted" | "timed_out"
  readonly exit_code: number
  readonly run_id: string | null
  readonly session_id: string | null
  readonly client_id: string | null
  readonly run_status: RunDetail["status"] | null
  /** The model the Run ran on, as the server names it (llama.cpp, OpenRouter: the server's own id). */
  readonly model_id: ReceiptRun["model_id"]
  readonly reasoning_effort: ReceiptRun["reasoning_effort"]
  /** The server's terminal result as it sent it. Its `cost` is the dollars the
   *  provider reported for the Run's model requests, absent when it reported
   *  none (llama.cpp, Codex): never an estimate (see the CLI README). */
  readonly result: ReceiptResult | null
  readonly error: CommandReceiptError | null
  readonly declined: ReadonlyArray<DeclinedRequest>
}

interface ReceiptIdentity {
  readonly runId: string | null
  readonly sessionId: string | null
  readonly clientId: string | null
}

const noIdentity: ReceiptIdentity = { runId: null, sessionId: null, clientId: null }

const failedReceipt = (
  command: CommandReceiptV1["command"],
  error: CommandReceiptError,
  input: {
    readonly identity?: ReceiptIdentity
    readonly status?: CommandReceiptV1["status"]
    readonly exitCode?: number
    readonly declined?: ReadonlyArray<DeclinedRequest>
  } = {}
): CommandReceiptV1 => {
  const identity = input.identity ?? noIdentity
  return {
    version: 1,
    type: "command_receipt",
    command,
    status: input.status ?? "failed",
    exit_code: input.exitCode ?? 1,
    run_id: identity.runId,
    session_id: identity.sessionId,
    client_id: identity.clientId,
    run_status: null,
    model_id: null,
    reasoning_effort: null,
    result: null,
    error,
    declined: input.declined ?? []
  }
}

const submittedReceipt = (run: SubmittedRun): CommandReceiptV1 => ({
  version: 1,
  type: "command_receipt",
  command: "run",
  status: "submitted",
  exit_code: 0,
  run_id: run.runId,
  session_id: run.sessionId,
  client_id: run.clientId,
  run_status: null,
  model_id: null,
  reasoning_effort: null,
  result: null,
  error: null,
  declined: []
})

export const invalidInputReceipt = (
  command: CommandReceiptV1["command"],
  message: string
): CommandReceiptV1 => failedReceipt(command, { code: "invalid_input", message }, { exitCode: 2 })

const progressWriter = (
  dependencies: CliDependencies,
  output: CliOutputFormat
): ((identity: ReceiptIdentity, event: HeadlessRunEvent) => void) => {
  const lineOf = progressLines()
  return (identity, event) => {
    if (output === "jsonl") {
      dependencies.writeStderr(
        `${JSON.stringify({
          version: 1,
          type: "run_event",
          run_id: identity.runId,
          session_id: identity.sessionId,
          event: event.data
        })}\n`
      )
      return
    }
    const line = output === "text" ? lineOf(event) : undefined
    if (line !== undefined) dependencies.writeStderr(`arden: ${line}\n`)
  }
}

const writeReceipt = (
  dependencies: CliDependencies,
  output: CliOutputFormat,
  receipt: CommandReceiptV1
): number => {
  if (output !== "text") {
    dependencies.writeStdout(`${JSON.stringify(receipt)}\n`)
    return receipt.exit_code
  }
  if (receipt.status === "submitted" && receipt.run_id !== null) {
    dependencies.writeStdout(`${receipt.run_id}\n`)
    dependencies.writeStderr(
      `arden: the Run goes on in Arden; follow it with: arden wait ${receipt.run_id}\n`
    )
  } else if (receipt.status === "completed" && receipt.result !== null) {
    const text = receipt.result.text
    if (text.length > 0) dependencies.writeStdout(text.endsWith("\n") ? text : `${text}\n`)
  } else if (receipt.error !== null) {
    dependencies.writeStderr(`arden: ${receipt.error.message}\n`)
  }
  return receipt.exit_code
}

const promptFor = async (options: RunOptions, dependencies: CliDependencies): Promise<string> => {
  const argument = options.promptArgument?.trim()
  if (argument !== undefined && argument.length > 0) {
    if (dependencies.stdin !== "pipe" && dependencies.stdin !== "file") return argument
    const piped = (await dependencies.readStdin()).trim()
    return piped.length === 0 ? argument : `${argument}\n\n<stdin>\n${piped}\n</stdin>`
  }
  if (dependencies.stdin === "terminal") {
    throw new UsageError("Provide a prompt argument or pipe a prompt on stdin")
  }
  return (await dependencies.readStdin()).trim()
}

const imageMediaType = (path: string): ChatImageInput["mediaType"] => {
  const extension = extname(path).toLowerCase()
  if (extension === ".png") return "image/png"
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg"
  throw new UsageError(`--image takes .png or .jpg files: ${path}`)
}

const readImages = (
  paths: ReadonlyArray<string>,
  dependencies: CliDependencies
): Promise<Array<ChatImageInput>> =>
  Promise.all(
    paths.map(async (path) => {
      const mediaType = imageMediaType(path)
      let bytes: Uint8Array
      try {
        bytes = await dependencies.readFile(path)
      } catch (cause) {
        throw new UsageError(`Cannot read image ${path}: ${errorMessage(cause)}`)
      }
      return { mediaType, data: Buffer.from(bytes).toString("base64") }
    })
  )

type OutputSchema = NonNullable<ChatMessageInput["outputSchema"]>

const isJsonObject = (value: unknown): value is OutputSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readOutputSchema = async (
  path: string | undefined,
  dependencies: CliDependencies
): Promise<OutputSchema | undefined> => {
  if (path === undefined) return undefined
  let text: string
  try {
    text = Buffer.from(await dependencies.readFile(path)).toString("utf8")
  } catch (cause) {
    throw new UsageError(`Cannot read the output schema ${path}: ${errorMessage(cause)}`)
  }
  let parsed: unknown
  try {
    parsed = parseJsonText(text)
  } catch (cause) {
    throw new UsageError(`The output schema ${path} is not JSON: ${errorMessage(cause)}`)
  }
  if (!isJsonObject(parsed))
    throw new UsageError(`The output schema ${path} must be a JSON Schema object`)
  return parsed
}

const resolveSpace = async (client: CliClient, reference: string): Promise<string> => {
  const { spaces } = await client.listSpaces()
  const byId = spaces.find((space) => space.space_id === reference)
  if (byId !== undefined) return byId.space_id
  const wanted = reference.trim().toLowerCase()
  const named = spaces.filter((space) => space.name.trim().toLowerCase() === wanted)
  const [only, ...others] = named
  if (only !== undefined && others.length === 0) return only.space_id
  if (only !== undefined) {
    throw new UsageError(
      `More than one Space is named "${reference}"; pass its id: ${named.map((space) => space.space_id).join(", ")}`
    )
  }
  const names = spaces.map((space) => space.name).join(", ")
  throw new UsageError(
    `No Space named "${reference}"${names.length === 0 ? "" : `. Spaces: ${names}`}`
  )
}

interface ResolvedSession {
  readonly sessionId: string
  readonly created: boolean
}

const resolveSession = async (
  client: CliClient,
  target: SessionTarget
): Promise<ResolvedSession> => {
  switch (target.kind) {
    case "existing":
      return { sessionId: target.sessionId, created: false }
    case "latest": {
      const page = await client.listSessions(latestChats(1))
      const latest = page.sessions[0]
      if (latest === undefined) throw new UsageError("There is no chat to continue")
      return { sessionId: latest.session_id, created: false }
    }
    case "fork":
      return {
        sessionId: (await client.branchSession(target.sessionId, wholeFork)).session_id,
        created: false
      }
    case "new": {
      if (target.model !== undefined) await requireModel(client, target.model)
      const spaceId =
        target.space === undefined ? undefined : await resolveSpace(client, target.space)
      const created = await client.createSession(newChat({ spaceId, model: target.model }))
      return { sessionId: created.session_id, created: true }
    }
  }
}

/**
 * A model the server does not list would make it refuse the new chat with no
 * reason; this names the models it has. On llama.cpp and OpenRouter the ids
 * are the server's own (`arden models`).
 */
const requireModel = async (client: CliClient, model: string): Promise<void> => {
  const ids = (await client.listModels()).providers.flatMap((provider) =>
    provider.models.map((entry) => entry.id)
  )
  if (ids.includes(model)) return
  throw new UsageError(
    `This server has no model ${model}. ${ids.length === 0 ? "It lists none." : `It lists: ${ids.join(", ")}`}`
  )
}

const discardIfEmpty = async (client: CliClient, sessionId: string): Promise<void> => {
  try {
    const page = await client.listSessions(oneSession(sessionId))
    const session = page.sessions.find((candidate) => candidate.session_id === sessionId)
    if (session === undefined || session.message_count > 0 || runIsActive(session.run)) return
    await client.deleteSession(sessionId)
  } catch {}
}

const OLDER_ENGINE_COMMAND_LINE_MODES: ReadonlySet<ChatApprovalMode> = new Set(["read_only", "ask"])

const submitted403 = (cause: unknown, mode: ChatApprovalMode): unknown =>
  cause instanceof HeadlessHttpError &&
  cause.status === 403 &&
  !OLDER_ENGINE_COMMAND_LINE_MODES.has(mode)
    ? new OlderServerError()
    : cause

export const failureOf = (
  cause: unknown
): { readonly error: CommandReceiptError; readonly exitCode: number } => {
  if (cause instanceof UsageError) {
    return { error: { code: "invalid_input", message: cause.message }, exitCode: 2 }
  }
  if (cause instanceof ServerUnavailableError) {
    return { error: { code: "server_unavailable", message: cause.message }, exitCode: 1 }
  }
  if (cause instanceof ProviderUnavailableError) {
    // The configured server's own exit code for it, so `exec` and `serve` agree.
    return {
      error: { code: "provider_unavailable", message: cause.message },
      exitCode: CONFIGURED_SERVER_EXIT.providerUnreachable
    }
  }
  if (cause instanceof NoModelError) {
    return { error: { code: "no_model", message: cause.message }, exitCode: 1 }
  }
  if (cause instanceof OlderServerError) {
    return { error: { code: "server_outdated", message: cause.message }, exitCode: 1 }
  }
  if (cause instanceof HeadlessHttpError) {
    return { error: { code: "command_failed", message: plainHttpMessage(cause) }, exitCode: 1 }
  }
  return { error: { code: "command_failed", message: errorMessage(cause) }, exitCode: 1 }
}

class InterruptError extends Error {
  override readonly name = "InterruptError"

  constructor() {
    super("Interrupted by SIGINT")
  }
}

const followAnswers = async (
  responder: RunResponder,
  first: RunDetail,
  follow: (runId: string) => Promise<RunDetail>
): Promise<RunDetail> => {
  let detail = first
  for (
    let next = await responder.afterRun();
    next !== undefined;
    next = await responder.afterRun()
  ) {
    detail = await follow(next)
  }
  return detail
}

export const runCommand = async (
  options: RunOptions,
  dependencies: CliDependencies
): Promise<number> => {
  const finish = (receipt: CommandReceiptV1): number =>
    writeReceipt(dependencies, options.output, receipt)
  const fail = (cause: unknown, identity: ReceiptIdentity = noIdentity): number => {
    const failure = failureOf(cause)
    return finish(failedReceipt("run", failure.error, { identity, exitCode: failure.exitCode }))
  }

  let prompt: string
  let images: Array<ChatImageInput>
  let outputSchema: OutputSchema | undefined
  let client: CliClient
  try {
    prompt = await promptFor(options, dependencies)
    if (prompt.length === 0) throw new UsageError("Prompt must not be empty")
    // The message contract's own limit, said before a chat is made for it.
    if (prompt.length > CHAT_MESSAGE_MAX_LENGTH)
      throw new UsageError(
        `The prompt is ${prompt.length} characters; one message takes at most ${CHAT_MESSAGE_MAX_LENGTH}`
      )
    images = await readImages(options.imagePaths, dependencies)
    outputSchema = await readOutputSchema(options.outputSchemaPath, dependencies)
    client = createCliClient(dependencies, await resolveServer(options.urlArgument, dependencies))
  } catch (cause) {
    return fail(cause)
  }

  const waitController = new AbortController()
  const declined: Array<DeclinedRequest> = []
  let interruptRequested = false
  let sessionId: string | undefined
  let unsent: string | undefined
  let submitted: SubmittedRun | undefined
  let cancelPromise: Promise<void> | undefined
  const identity = (): ReceiptIdentity => ({
    runId: submitted?.runId ?? null,
    sessionId: submitted?.sessionId ?? sessionId ?? null,
    clientId: submitted?.clientId ?? null
  })
  const stopped = (status: "interrupted" | "timed_out", message: string): number =>
    finish(
      failedReceipt(
        "run",
        { code: status, message },
        { identity: identity(), status, exitCode: status === "interrupted" ? 130 : 124, declined }
      )
    )

  const requestCancel = (): Promise<void> => {
    if (submitted === undefined) return Promise.resolve()
    if (cancelPromise !== undefined) return cancelPromise
    const timeout = abortAfter(
      5_000,
      () => new Error("Cancellation was not acknowledged within 5 seconds")
    )
    cancelPromise = client
      .cancel({ runId: submitted.runId }, { signal: timeout.signal })
      .then(
        () => undefined,
        (cause) => {
          dependencies.writeStderr(
            `arden: cancellation request failed: ${failureOf(cause).error.message}\n`
          )
        }
      )
      .finally(() => timeout.cancel())
    return cancelPromise
  }
  const removeSigint = dependencies.onSigint(() => {
    interruptRequested = true
    waitController.abort(new InterruptError())
    void requestCancel()
  })

  try {
    if (!(await client.health()).hasProviders) {
      throw new NoModelError(
        "Arden has no model to answer with. Sign in to a model provider in Arden, or start a server with a provider in its settings (`arden serve --config`)."
      )
    }
    const resolved = await resolveSession(client, options.target)
    sessionId = resolved.sessionId
    if (resolved.created) unsent = resolved.sessionId
    if (interruptRequested) return stopped("interrupted", "Interrupted by SIGINT")

    const accepted = await client
      .submit({
        sessionId,
        message: prompt,
        ...(images.length === 0 ? {} : { images }),
        ...(outputSchema === undefined ? {} : { outputSchema }),
        approvalMode: options.approvalMode
      })
      .catch((cause: unknown) => {
        throw submitted403(cause, options.approvalMode)
      })
    submitted = accepted
    unsent = undefined
    if (interruptRequested) {
      await requestCancel()
      return stopped("interrupted", "Interrupted by SIGINT")
    }
    if (options.detach) return finish(submittedReceipt(accepted))

    const writeProgress = progressWriter(dependencies, options.output)
    const respond = requestResponder({
      client,
      runId: accepted.runId,
      handling: options.approvals,
      output: options.output,
      dependencies,
      declined
    })
    const waiting = {
      signal: waitController.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      onEvent: async (event: HeadlessRunEvent, signal: AbortSignal) => {
        writeProgress(identity(), event)
        await respond.onEvent(event, signal)
      }
    }
    const detail = await followAnswers(respond, await client.wait(accepted, waiting), (runId) =>
      client.waitForRun(runId, waiting)
    )
    if (interruptRequested) {
      await requestCancel()
      return stopped("interrupted", "Interrupted by SIGINT")
    }
    return finish(receiptFromRun("run", detail, declined))
  } catch (cause) {
    if (interruptRequested || cause instanceof InterruptError) {
      await requestCancel()
      return stopped("interrupted", "Interrupted by SIGINT")
    }
    if (cause instanceof HeadlessTimeoutError) {
      await requestCancel()
      return stopped("timed_out", cause.message)
    }
    return fail(cause, identity())
  } finally {
    removeSigint()
    if (unsent !== undefined) await discardIfEmpty(client, unsent)
  }
}

export const waitCommand = async (
  options: WaitOptions,
  dependencies: CliDependencies
): Promise<number> => {
  const finish = (receipt: CommandReceiptV1): number =>
    writeReceipt(dependencies, options.output, receipt)
  const identity: ReceiptIdentity = { runId: options.runId, sessionId: null, clientId: null }
  let client: CliClient
  try {
    client = createCliClient(dependencies, await resolveServer(options.urlArgument, dependencies))
  } catch (cause) {
    const failure = failureOf(cause)
    return finish(failedReceipt("wait", failure.error, { identity, exitCode: failure.exitCode }))
  }

  const controller = new AbortController()
  const declined: Array<DeclinedRequest> = []
  const removeSigint = dependencies.onSigint(() => controller.abort(new InterruptError()))
  const writeProgress = progressWriter(dependencies, options.output)
  const respond = requestResponder({
    client,
    runId: options.runId,
    handling: options.approvals,
    output: options.output,
    dependencies,
    declined
  })
  try {
    const follow = (runId: string): Promise<RunDetail> =>
      client.waitForRun(runId, {
        signal: controller.signal,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        onEvent: async (event, signal) => {
          writeProgress(identity, event)
          await respond.onEvent(event, signal)
        }
      })
    const detail = await followAnswers(respond, await follow(options.runId), follow)
    return finish(receiptFromRun("wait", detail, declined))
  } catch (cause) {
    if (controller.signal.aborted || cause instanceof InterruptError) {
      return finish(
        failedReceipt(
          "wait",
          { code: "interrupted", message: "Stopped waiting; the Run goes on in Arden" },
          { identity, status: "interrupted", exitCode: 130, declined }
        )
      )
    }
    if (cause instanceof HeadlessTimeoutError) {
      return finish(
        failedReceipt(
          "wait",
          { code: "timed_out", message: `${cause.message}; the Run goes on in Arden` },
          { identity, status: "timed_out", exitCode: 124, declined }
        )
      )
    }
    const failure = failureOf(cause)
    return finish(
      failedReceipt("wait", failure.error, { identity, exitCode: failure.exitCode, declined })
    )
  } finally {
    removeSigint()
  }
}

export interface SessionsOptions {
  readonly urlArgument: string | undefined
  readonly limit: number
  readonly output: "text" | "json"
}

export const sessionsCommand = async (
  options: SessionsOptions,
  dependencies: CliDependencies
): Promise<number> => {
  try {
    const client = createCliClient(
      dependencies,
      await resolveServer(options.urlArgument, dependencies)
    )
    const page = await client.listSessions(latestChats(options.limit))
    const sessions = page.sessions.map((session) => ({
      session_id: session.session_id,
      name: nameText(session.name),
      space_id: spaceIdOf(session.space),
      last_activity: session.last_activity,
      is_active: runIsActive(session.run),
      pending_approvals: session.pending_approvals_count
    }))
    if (options.output === "json") {
      dependencies.writeStdout(
        `${JSON.stringify({ version: 1, type: "session_list", sessions })}\n`
      )
      return 0
    }
    for (const session of sessions) {
      const state =
        session.pending_approvals > 0 ? `  (${session.pending_approvals} to approve)` : ""
      dependencies.writeStdout(
        `${session.session_id}  ${session.last_activity}  ${session.name ?? "Untitled chat"}${state}\n`
      )
    }
    return 0
  } catch (cause) {
    const failure = failureOf(cause)
    dependencies.writeStderr(`arden: ${failure.error.message}\n`)
    return failure.exitCode
  }
}
