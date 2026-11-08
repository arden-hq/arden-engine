import {
  HeadlessHttpError,
  HeadlessTimeoutError,
  type HeadlessRunEvent,
  type RunDetail,
  type RunTerminalResult,
  type SubmittedRun
} from "@arden-hq/headless"
import type { ChatApprovalMode, ChatImageInput, ChatMessageInput } from "@arden-hq/protocol/chat"
import { extname } from "node:path"

import {
  createCliClient,
  NoModelError,
  resolveServer,
  ServerUnavailableError,
  UsageError,
  type CliClient,
  type CliDependencies
} from "./command.js"
import { errorMessage } from "@arden-hq/std/errors"

export type CliOutputFormat = "text" | "json" | "jsonl"

export type ApprovalHandling = "wait" | "decline"

export type SessionTarget =
  | { readonly kind: "new"; readonly space: string | undefined; readonly model: string | undefined }
  | { readonly kind: "existing"; readonly sessionId: string }
  | { readonly kind: "latest" }
  | { readonly kind: "fork"; readonly sessionId: string }

export interface RunOptions {
  readonly promptArgument: string | undefined
  readonly urlArgument: string | undefined
  readonly target: SessionTarget
  readonly recipe: string | undefined
  readonly imagePaths: ReadonlyArray<string>
  readonly outputSchemaPath: string | undefined
  readonly approvalMode: ChatApprovalMode | undefined
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
  readonly result: RunTerminalResult | null
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
  result: null,
  error: null,
  declined: []
})

export const invalidInputReceipt = (
  command: CommandReceiptV1["command"],
  message: string
): CommandReceiptV1 => failedReceipt(command, { code: "invalid_input", message }, { exitCode: 2 })

const receiptFromRun = (
  command: CommandReceiptV1["command"],
  detail: RunDetail,
  declined: ReadonlyArray<DeclinedRequest>
): CommandReceiptV1 => {
  const base = {
    version: 1,
    type: "command_receipt",
    command,
    run_id: detail.run_id,
    session_id: detail.session_id,
    client_id: detail.client_id,
    run_status: detail.status,
    declined
  } as const
  if (detail.status === "completed" && detail.result !== null) {
    return { ...base, status: "completed", exit_code: 0, result: detail.result, error: null }
  }

  const error = detail.error ?? {
    code: detail.status === "completed" ? "missing_result" : detail.status,
    message:
      detail.stop_reason ??
      (detail.status === "completed"
        ? "Completed Run has no terminal result"
        : `Run ended with status ${detail.status}`)
  }
  return {
    ...base,
    status:
      detail.status === "cancelled" || detail.status === "interrupted" ? detail.status : "failed",
    exit_code: 1,
    result: null,
    error
  }
}

const humanProgressEvents: ReadonlySet<string> = new Set([
  "RUN_STARTED",
  "RUN_FINISHED",
  "RUN_ERROR",
  "run_cancelled",
  "run_backgrounded",
  "input_needed",
  "TOOL_CALL_START",
  "TOOL_CALL_END",
  "task_started",
  "task_finished"
])

const writeProgress = (
  dependencies: CliDependencies,
  output: CliOutputFormat,
  identity: ReceiptIdentity,
  event: HeadlessRunEvent
): void => {
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
  if (output === "text" && humanProgressEvents.has(event.data.type)) {
    dependencies.writeStderr(`arden: ${event.data.type}\n`)
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

const DECLINED_NOTE =
  "No one was at the command line to answer this, so it was declined. Carry on without it."

const requestResponder = (input: {
  readonly client: CliClient
  readonly runId: string
  readonly handling: ApprovalHandling
  readonly output: CliOutputFormat
  readonly dependencies: CliDependencies
  readonly declined: Array<DeclinedRequest>
}): ((event: HeadlessRunEvent) => Promise<void>) => {
  const handled = new Set<string>()
  const say = (line: string): void => {
    if (input.output === "text") input.dependencies.writeStderr(`arden: ${line}\n`)
  }
  return async (event) => {
    const data = event.data
    if (data.type !== "approval_needed" && data.type !== "connection_needed") return
    if (data.run_id !== undefined && data.run_id !== null && data.run_id !== input.runId) return
    if (handled.has(data.tool_id)) return
    handled.add(data.tool_id)
    const name = data.type === "approval_needed" ? data.name : data.label
    if (input.handling === "wait") {
      say(`waiting for someone to answer in Arden: ${name}`)
      return
    }
    try {
      if (data.type === "approval_needed") {
        await input.client.answerApproval({
          runId: input.runId,
          toolId: data.tool_id,
          result: DECLINED_NOTE,
          approved: false
        })
      } else {
        await input.client.answerConnection({
          runId: input.runId,
          toolId: data.tool_id,
          connectionId: data.connection_id,
          result: DECLINED_NOTE,
          approved: false
        })
      }
      input.declined.push({
        kind: data.type === "approval_needed" ? "approval" : "connection",
        tool_id: data.tool_id,
        name
      })
      say(`declined ${name}: no one is here to answer it`)
    } catch (cause) {
      say(`could not decline ${name}: ${errorMessage(cause)}`)
    }
  }
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
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new UsageError(`The output schema ${path} is not JSON: ${errorMessage(cause)}`)
  }
  if (!isJsonObject(parsed)) {
    throw new UsageError(`The output schema ${path} must be a JSON Schema object`)
  }
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
      const page = await client.listSessions({ scope: "primary", sort: "activity", limit: 1 })
      const latest = page.sessions[0]
      if (latest === undefined) throw new UsageError("There is no chat to continue")
      return { sessionId: latest.session_id, created: false }
    }
    case "fork":
      return {
        sessionId: (await client.branchSession(target.sessionId)).session_id,
        created: false
      }
    case "new": {
      const spaceId =
        target.space === undefined ? undefined : await resolveSpace(client, target.space)
      const created = await client.createSession({
        ...(spaceId === undefined ? {} : { space_id: spaceId }),
        ...(target.model === undefined ? {} : { chat_model: target.model })
      })
      return { sessionId: created.session_id, created: true }
    }
  }
}

const discardIfEmpty = async (client: CliClient, sessionId: string): Promise<void> => {
  try {
    const page = await client.listSessions({ sessionIds: [sessionId], scope: "all" })
    const session = page.sessions.find((candidate) => candidate.session_id === sessionId)
    if (session === undefined || session.message_count > 0 || session.is_active) return
    await client.deleteSession(sessionId)
  } catch {}
}

const refusalMessage = (cause: HeadlessHttpError): string => {
  try {
    const body: unknown = JSON.parse(cause.detail)
    if (typeof body === "object" && body !== null && "detail" in body) {
      const detail = body.detail
      if (typeof detail === "string" && detail.length > 0) return detail
    }
  } catch {}
  return cause.message
}

const failureOf = (
  cause: unknown
): { readonly error: CommandReceiptError; readonly exitCode: number } => {
  if (cause instanceof UsageError) {
    return { error: { code: "invalid_input", message: cause.message }, exitCode: 2 }
  }
  if (cause instanceof ServerUnavailableError) {
    return { error: { code: "server_unavailable", message: cause.message }, exitCode: 1 }
  }
  if (cause instanceof NoModelError) {
    return { error: { code: "no_model", message: cause.message }, exitCode: 1 }
  }
  if (cause instanceof HeadlessHttpError) {
    return { error: { code: "command_failed", message: refusalMessage(cause) }, exitCode: 1 }
  }
  return { error: { code: "command_failed", message: errorMessage(cause) }, exitCode: 1 }
}

class InterruptError extends Error {
  override readonly name = "InterruptError"

  constructor() {
    super("Interrupted by SIGINT")
  }
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
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(new Error("Cancellation was not acknowledged within 5 seconds"))
    }, 5_000)
    cancelPromise = client
      .cancel({ runId: submitted.runId }, { signal: controller.signal })
      .then(
        () => undefined,
        (cause) => {
          dependencies.writeStderr(`arden: cancellation request failed: ${errorMessage(cause)}\n`)
        }
      )
      .finally(() => clearTimeout(timeout))
    return cancelPromise
  }
  const removeSigint = dependencies.onSigint(() => {
    interruptRequested = true
    waitController.abort(new InterruptError())
    void requestCancel()
  })

  try {
    if (!(await client.health()).hasProviders) {
      throw new NoModelError("Arden has no model to answer with. Sign in to one in Arden first.")
    }
    const resolved = await resolveSession(client, options.target)
    sessionId = resolved.sessionId
    if (resolved.created) unsent = resolved.sessionId
    if (interruptRequested) return stopped("interrupted", "Interrupted by SIGINT")

    const accepted = await client.submit({
      sessionId,
      message: prompt,
      ...(images.length === 0 ? {} : { images }),
      ...(options.recipe === undefined ? {} : { recipe: options.recipe }),
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(options.approvalMode === undefined ? {} : { approvalMode: options.approvalMode })
    })
    submitted = accepted
    unsent = undefined
    if (interruptRequested) {
      await requestCancel()
      return stopped("interrupted", "Interrupted by SIGINT")
    }
    if (options.detach) {
      return finish(submittedReceipt(accepted))
    }

    const respond = requestResponder({
      client,
      runId: accepted.runId,
      handling: options.approvals,
      output: options.output,
      dependencies,
      declined
    })
    const detail = await client.wait(accepted, {
      signal: waitController.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      onEvent: async (event) => {
        writeProgress(dependencies, options.output, identity(), event)
        await respond(event)
      }
    })
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
  const respond = requestResponder({
    client,
    runId: options.runId,
    handling: options.approvals,
    output: options.output,
    dependencies,
    declined
  })
  try {
    const detail = await client.waitForRun(options.runId, {
      signal: controller.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      onEvent: async (event) => {
        writeProgress(dependencies, options.output, identity, event)
        await respond(event)
      }
    })
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
    const page = await client.listSessions({
      scope: "primary",
      sort: "activity",
      limit: options.limit
    })
    const sessions = page.sessions.map((session) => ({
      session_id: session.session_id,
      name: session.name,
      space_id: session.space_id,
      last_activity: session.last_activity,
      is_active: session.is_active,
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
    dependencies.writeStderr(`arden: ${errorMessage(cause)}\n`)
    return failureOf(cause).exitCode
  }
}
