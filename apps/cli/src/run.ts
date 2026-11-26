import { abortAfter } from "@arden-hq/std/timer"
import { latestChats, oneSession } from "./session-list.js"
import { newChat, wholeFork } from "./session-requests.js"
import { receiptFromRun } from "./run-receipt-detail.js"
import { nameText, runIsActive, spaceIdOf } from "@arden-hq/protocol/sessions"
import {
  HeadlessHttpError,
  HeadlessTimeoutError,
  type HeadlessRunEvent,
  type RunDetail,
  type SubmittedRun
} from "@arden-hq/headless"
import { runMessage, type OutputSchema } from "./run-message.js"
import {
  CANCEL_TARGET,
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatApprovalMode,
  type ChatImageInput
} from "@arden-hq/protocol/chat"
import { CONFIGURED_SERVER_EXIT } from "@arden-hq/protocol/daemon"

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
import { requestResponder, type RunResponder } from "./terminal.js"
import { parseJsonText } from "@arden-hq/std/json-text"
import {
  type CliOutputFormat,
  type CommandReceiptV1,
  type DeclinedRequest,
  type ReceiptIdentity,
  failedReceipt,
  noIdentity,
  progressWriter,
  submittedReceipt,
  writeReceipt,
  type CommandReceiptError
} from "./run-receipt.js"

import {
  CLI_OUTPUT_FORMAT,
  RECEIPT_STATUS,
  SESSION_TARGET,
  STDIN_KIND,
  type ApprovalHandling
} from "./cli-words.js"
import { readImages } from "./run-images.js"
export type { ApprovalHandling }

export type SessionTarget =
  | {
      readonly kind: typeof SESSION_TARGET.new
      readonly space: string | undefined
      readonly model: string | undefined
    }
  | { readonly kind: typeof SESSION_TARGET.existing; readonly sessionId: string }
  | { readonly kind: typeof SESSION_TARGET.latest }
  | { readonly kind: typeof SESSION_TARGET.fork; readonly sessionId: string }

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

const promptFor = async (options: RunOptions, dependencies: CliDependencies): Promise<string> => {
  const argument = options.promptArgument?.trim()
  if (argument !== undefined && argument.length > 0) {
    if (dependencies.stdin !== STDIN_KIND.pipe && dependencies.stdin !== STDIN_KIND.file)
      return argument
    const piped = (await dependencies.readStdin()).trim()
    return piped.length === 0 ? argument : `${argument}\n\n<stdin>\n${piped}\n</stdin>`
  }
  if (dependencies.stdin === STDIN_KIND.terminal) {
    throw new UsageError("Provide a prompt argument or pipe a prompt on stdin")
  }
  return (await dependencies.readStdin()).trim()
}

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
    case SESSION_TARGET.existing:
      return { sessionId: target.sessionId, created: false }
    case SESSION_TARGET.latest: {
      const page = await client.listSessions(latestChats(1))
      const latest = page.sessions[0]
      if (latest === undefined) throw new UsageError("There is no chat to continue")
      return { sessionId: latest.session_id, created: false }
    }
    case SESSION_TARGET.fork:
      return {
        sessionId: (await client.branchSession(target.sessionId, wholeFork)).session_id,
        created: false
      }
    case SESSION_TARGET.new: {
      if (target.model !== undefined) await requireModel(client, target.model)
      const spaceId =
        target.space === undefined ? undefined : await resolveSpace(client, target.space)
      const created = await client.createSession(newChat({ spaceId, model: target.model }))
      return { sessionId: created.session_id, created: true }
    }
  }
}

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
        {
          identity: identity(),
          status,
          exitCode: status === RECEIPT_STATUS.interrupted ? 130 : 124,
          declined
        }
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
      .cancel({ kind: CANCEL_TARGET.run, runId: submitted.runId }, { signal: timeout.signal })
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

    const message = runMessage({ sessionId, prompt, images, outputSchema, ...options })
    const accepted = await client.submit(message).catch((cause: unknown) => {
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
    if (options.output === CLI_OUTPUT_FORMAT.json) {
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
