import { mkdir, readFile, writeFile, realpath, stat } from "node:fs/promises"
import { resolve, join, relative, isAbsolute } from "node:path"
import { Schema } from "effect"
import { fileURLToPath } from "node:url"
import { readProfile, modelHost, modelSettings } from "./profile.mjs"
import { createHeadlessClient, startConfiguredServer } from "../libs/headless/dist/index.js"
import { automationRoutes } from "../libs/protocol/dist/automations/index.js"
import { contextRoutes } from "../libs/protocol/dist/context/index.js"
import { permissionRoutes } from "../libs/protocol/dist/permissions/index.js"
import { toolRoutes } from "../libs/protocol/dist/tools/index.js"
import {
  SESSION_MODEL,
  SESSION_NAME,
  SESSION_ORIGIN,
  SESSION_SPACE,
  sessionRoutes
} from "../libs/protocol/dist/sessions/index.js"
import {
  ANSWER_SHAPE,
  APPROVAL_ASKED,
  APPROVAL_REPLY,
  CHAT_CAPTURE,
  CONNECTION_RESULT,
  DECISION_ASKED,
  RELAY_COMMAND,
  REQUESTED_MODE,
  SENT_FROM,
  STANDING_GRANT,
  TOOL_DECISION
} from "../libs/protocol/dist/chat/index.js"
import { RUN_FAILURE, RUN_RESULT, RUN_STATUS } from "../libs/protocol/dist/runs/index.js"
import { SERVER_EVENT_TYPE } from "../libs/protocol/dist/index.js"
import { ERRNO, errorMessage, isErrnoCode } from "../libs/std/dist/errors.js"
import { parseJsonText } from "../libs/std/dist/json-text.js"
import { sleep } from "../libs/std/dist/sleep.js"
import { importHistory } from "./history.mjs"

const resultText = (run) =>
  run?.result?.kind === RUN_RESULT.none ? "" : (run?.result?.result?.text ?? "")

const failureMessage = (run) =>
  run.failure?.kind === RUN_FAILURE.failed ? run.failure.message : undefined

const SERVER_ENTRY = fileURLToPath(new URL("../apps/server-ts/dist/main.js", import.meta.url))

const Job = Schema.Struct({
  id: Schema.NonEmptyString,
  workspace: Schema.NonEmptyString,
  output: Schema.NonEmptyString,
  prompts: Schema.NonEmptyArray(Schema.NonEmptyString),
  skills: Schema.optionalKey(Schema.NonEmptyString),
  restartAfter: Schema.optionalKey(Schema.Array(Schema.Natural)),
  history: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.NonEmptyString,
        date: Schema.NonEmptyString,
        messages: Schema.Array(
          Schema.Struct({ role: Schema.Literals(["user", "assistant"]), content: Schema.String })
        )
      })
    )
  )
})
const within = (child, parent) => {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}
const save = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })

async function main() {
  const [profileFile, jobFile] = process.argv.slice(2)
  if (!profileFile || !jobFile) throw new Error("Usage: node benchmarks/candidate.mjs PROFILE JOB")
  const profile = await readProfile(profileFile)
  const deadline = AbortSignal.timeout(profile.timeoutMs)
  const job = Schema.decodeUnknownSync(Job)(parseJsonText(await readFile(jobFile, "utf8")), {
    onExcessProperty: "error"
  })
  const state = process.env.ARDEN_DIR
  if (!state || !isAbsolute(state))
    throw new Error("ARDEN_DIR must be an explicit absolute trial directory")
  await mkdir(state, { recursive: true, mode: 0o700 })
  const stateRoot = await realpath(state)
  const workspace = await realpath(job.workspace)
  await mkdir(resolve(job.output), { recursive: true, mode: 0o700 })
  const output = await realpath(job.output)
  if (within(stateRoot, workspace) || within(workspace, stateRoot) || within(output, workspace)) {
    throw new Error("State and output must be outside the task workspace")
  }
  const databasePath = join(stateRoot, "arden.db")
  try {
    await stat(databasePath)
    throw new Error(
      "Candidate requires fresh state; resume only completed trials through the driver"
    )
  } catch (error) {
    if (!isErrnoCode(error, ERRNO.ENOENT)) throw error
  }
  await mkdir(output, { recursive: true, mode: 0o700 })
  await save(join(output, "profile.json"), profile)
  const models = modelHost(profile)
  const imported = job.history
    ? await importHistory({ databasePath, models, history: job.history })
    : []
  await save(join(output, "history-import.json"), imported)
  const MEMORY_CAPTURE = "builtin-memory-capture"
  const settings = {
    dataDirectory: stateRoot,
    ...modelSettings(profile),
    maxModelRequests: profile.maxModelRequests,
    toolSearch: profile.toolSearch === true,
    ...(profile.tools ? { tools: profile.tools } : { blockedTools: profile.blockedTools }),
    workspace,
    memory: profile.memory,
    automations: false,
    ...(imported.length ? { keepAutomations: [MEMORY_CAPTURE] } : {}),
    ...(profile.mcpServers ? { mcpServers: profile.mcpServers } : {}),
    skillRoots: job.skills === undefined ? [] : [job.skills],
    idleCompactionAfterMs: 0,
    ...(profile.commandSandbox === false ? { commandSandbox: false } : {}),
    approvalMode: "allow"
  }
  const settingsFile = join(output, "settings.json")
  await save(settingsFile, settings)
  const interrupted = new AbortController()
  const onSignal = () => interrupted.abort(new Error("Candidate interrupted"))
  process.on("SIGTERM", onSignal)
  process.on("SIGINT", onSignal)
  const signal = AbortSignal.any([deadline, interrupted.signal])
  const start = async () => {
    const started = await startConfiguredServer({
      entry: SERVER_ENTRY,
      config: settingsFile,
      env: process.env,
      onLog: (chunk) => process.stderr.write(chunk),
      signal
    })
    const { ready, connection, stop } = started
    return {
      ready,
      headers: connection.headers,
      stop,
      fetch: (path, init) => fetch(new URL(path, connection.url), init),
      client: createHeadlessClient({ baseUrl: connection.url, headers: connection.headers })
    }
  }
  let server = await start().catch(async (error) => {
    await save(join(output, "result.json"), {
      id: job.id,
      status: "error",
      error: errorMessage(error),
      runs: []
    })
    throw error
  })
  let client = server.client
  await save(join(output, "tools-without-rule.json"), server.ready.toolsWithoutRule)
  const send = (path, method, body) =>
    server.fetch(path, {
      method,
      headers: { ...server.headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body }),
      signal
    })
  const request = async (path, method = "GET", body) => {
    const response = await send(path, method, body)
    if (!response.ok)
      throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
    return parseJsonText(await response.text())
  }
  const prompted = (prompt) =>
    `Your working folder is ${workspace}. Use absolute paths inside it, and pass it as the working directory of every command.\n\n${prompt}`
  const DECLINED = "No one is here to answer this, so it was declined. Carry on without it."
  const declined = []
  const decline = (runId) => async (event) => {
    const data = event.data
    if (
      data.type !== SERVER_EVENT_TYPE.approvalNeeded &&
      data.type !== SERVER_EVENT_TYPE.connectionNeeded
    )
      return
    if (declined.some((entry) => entry.toolId === data.tool_id)) return
    const toolId = data.tool_id
    const answeredRunId = data.run_id ?? runId
    declined.push({
      runId: answeredRunId,
      toolId,
      result: DECLINED,
      approved: false,
      kind: data.type,
      name: data.name ?? data.label
    })
    if (data.type === SERVER_EVENT_TYPE.approvalNeeded)
      await client.answerApproval({
        runId: answeredRunId,
        toolId,
        result: DECLINED,
        decision: { kind: TOOL_DECISION.denied, grant: { kind: STANDING_GRANT.once } },
        asked:
          data.asked.kind === APPROVAL_ASKED.recorded
            ? { kind: DECISION_ASKED.at, at: data.asked.at }
            : { kind: DECISION_ASKED.unstated },
        command: { kind: RELAY_COMMAND.none }
      })
    else
      await client.answerConnection({
        runId: answeredRunId,
        toolId,
        connectionId: data.connection_id,
        result: { kind: CONNECTION_RESULT.stated, text: DECLINED },
        approved: false
      })
  }
  let submitted
  let sessionId
  const runs = []
  let baselineRuns = new Set()
  const settle = async () => {
    while (true) {
      signal.throwIfAborted()
      if ((await client.listRuns({ active: true })).idle) return
      await sleep(100, signal)
    }
  }
  try {
    const toggle = (id) => request(`/automations/${encodeURIComponent(id)}/toggle`, "POST")
    if (profile.mcpServers?.length)
      await save(join(output, "mcp-servers.json"), (await request("/mcp/servers")).servers)
    await save(join(output, "effective-config.json"), await request("/config"))
    await save(join(output, "tool-catalog.json"), await request(toolRoutes.catalog))
    await save(join(output, "permission-rules.json"), await request(permissionRoutes.rules))
    await save(join(output, "command-sandbox.json"), await request(permissionRoutes.commandSandbox))
    if (imported.length) {
      if (!profile.memory) throw new Error("History ingestion requires a memory-enabled profile")
      await request(`/automations/${MEMORY_CAPTURE}/run`, "POST", "{}")
      let captureRuns
      while (true) {
        signal.throwIfAborted()
        captureRuns = (await request(automationRoutes.runs(MEMORY_CAPTURE, { limit: 20 }))).runs
        if (captureRuns.length > 0 && captureRuns.every((run) => run.status !== RUN_STATUS.running))
          break
        await sleep(200, signal)
      }
      await save(join(output, "memory-capture.json"), captureRuns)
      if (captureRuns.some((run) => run.status !== RUN_STATUS.completed))
        throw new Error("Memory capture did not complete successfully")
      await toggle(MEMORY_CAPTURE)
    }
    baselineRuns = new Set((await client.listRuns()).runs.map((run) => run.run_id))
    const session = await client.createSession({
      name: { kind: SESSION_NAME.named, name: job.id },
      space: { kind: SESSION_SPACE.none },
      chat_model: { kind: SESSION_MODEL.inherited },
      origin: SESSION_ORIGIN.ordinary
    })
    sessionId = session.session_id
    for (const [index, prompt] of job.prompts.entries()) {
      submitted = await client.submit({
        sessionId,
        clientId: `${job.id}-${index}`,
        message: prompted(prompt),
        images: [],
        replyTo: [],
        approvalReply: { kind: APPROVAL_REPLY.none },
        approvalMode: { kind: REQUESTED_MODE.current },
        sentFrom: { kind: SENT_FROM.typed },
        capture: { kind: CHAT_CAPTURE.none },
        outputSchema: { kind: ANSWER_SHAPE.free }
      })
      await client.wait(submitted, { signal, onEvent: decline(submitted.runId) })
      await settle()
      const latest = (await client.listRuns({ sessionId })).runs.at(-1)
      const run = await client.getRun(latest.run_id)
      runs.push(run)
      await save(join(output, `run-${index}.json`), run)
      await save(
        join(output, `context-${index}.json`),
        await request(contextRoutes.experiments(sessionId))
      )
      if (run.status !== RUN_STATUS.completed)
        throw new Error(`Run ended ${run.status}: ${failureMessage(run) ?? run.stop_reason}`)
      if (job.restartAfter?.includes(index)) {
        await server.stop()
        server = await start()
        client = server.client
        await save(join(output, `restart-${index}.json`), { sessionId, afterRun: run.run_id })
      }
    }
    await save(join(output, "result.json"), {
      id: job.id,
      status: "completed",
      text: resultText(runs.at(-1)),
      runs
    })
  } catch (error) {
    const listed = await client.listRuns({ active: true }).catch(() => ({ runs: [] }))
    for (const active of listed.runs)
      await client.cancel({ runId: active.run_id }).catch(() => undefined)
    if (submitted) {
      await client.cancel({ runId: submitted.runId }).catch(() => undefined)
      if (!runs.some((run) => run.run_id === submitted.runId)) {
        const partial = await client.getRun(submitted.runId).catch(() => undefined)
        if (partial) runs.push(partial)
      }
    }
    await save(join(output, "result.json"), {
      id: job.id,
      status: "error",
      error: errorMessage(error),
      runs
    })
    throw error
  } finally {
    try {
      if (sessionId) {
        const exported = await server.fetch(sessionRoutes.export(sessionId, "archive"), {
          headers: server.headers
        })
        if (!exported.ok) throw new Error(`Transcript export failed: ${exported.status}`)
        await save(join(output, "session.json"), parseJsonText(await exported.text()))
      }
      const trialRows = (await client.listRuns()).runs
      await save(
        join(output, "run-phases.json"),
        Object.fromEntries(
          trialRows.map((row) => [row.run_id, baselineRuns.has(row.run_id) ? "ingestion" : "task"])
        )
      )
      await save(
        join(output, "trial-runs.json"),
        await Promise.all(trialRows.map((row) => client.getRun(row.run_id)))
      )
      for (const childId of new Set(trialRows.map((row) => row.session_id))) {
        if (childId === sessionId) continue
        const exported = await server.fetch(sessionRoutes.export(childId, "archive"), {
          headers: server.headers
        })
        if (!exported.ok) throw new Error(`Child transcript export failed: ${exported.status}`)
        await save(join(output, `session-${childId}.json`), parseJsonText(await exported.text()))
      }
      for (const run of trialRows) {
        let afterSequence = 0
        const events = []
        while (true) {
          const page = await client.getRunEvents(run.run_id, { afterSequence, limit: 200 })
          events.push(...page.events)
          if (!page.has_more) break
          if (page.next_after_sequence <= afterSequence)
            throw new Error("Run event cursor did not advance")
          afterSequence = page.next_after_sequence
        }
        await save(join(output, `${run.run_id}-events.json`), events)
      }
    } catch (error) {
      await save(join(output, "result.json"), {
        id: job.id,
        status: "error",
        error: `Evidence export failed: ${String(error)}`,
        runs
      })
      throw error
    } finally {
      try {
        await save(
          join(output, "usage.json"),
          parseJsonText(await readFile(server.ready.usageFile, "utf8"))
        )
        await save(join(output, "declined-requests.json"), declined)
      } finally {
        process.off("SIGTERM", onSignal)
        process.off("SIGINT", onSignal)
        await server.stop()
      }
    }
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
