import { mkdir, readFile, writeFile, realpath, stat } from "node:fs/promises"
import { resolve, join, relative, isAbsolute } from "node:path"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as sleep } from "node:timers/promises"
import { Schema } from "effect"
import { readProfile, modelHost } from "./profile.mjs"
import { startServerWithLocalAccess } from "../apps/server-ts/dist/server.js"
import { benchmarkProvider } from "./provider.mjs"
import { createHeadlessClient } from "../libs/headless/dist/index.js"
import { contextRoutes, fullContext } from "../libs/protocol/dist/context/index.js"
import { permissionRoutes } from "../libs/protocol/dist/permissions/index.js"
import { toolDecoders, toolRoutes } from "../libs/protocol/dist/tools/index.js"
import { sessionRoutes } from "../libs/protocol/dist/sessions/index.js"
import { mcpDecoders, mcpRequests, mcpRoutes } from "../libs/protocol/dist/mcp/index.js"
import { intelligenceSettingsRequests } from "../libs/protocol/dist/settings/index.js"
import { errorMessage } from "../libs/std/dist/errors.js"
import { importHistory } from "./history.mjs"

const Job = Schema.Struct({
  id: Schema.NonEmptyString,
  workspace: Schema.NonEmptyString,
  output: Schema.NonEmptyString,
  prompts: Schema.NonEmptyArray(Schema.NonEmptyString),
  // False sends each prompt as written, for a suite whose task uses no files.
  nameWorkspace: Schema.optionalKey(Schema.Boolean),
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
  // The time limit counts from here, so setup and history import are inside it.
  const deadline = AbortSignal.timeout(profile.timeoutMs)
  const job = Schema.decodeUnknownSync(Job)(JSON.parse(await readFile(jobFile, "utf8")), {
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
    if (error.code !== "ENOENT") throw error
  }
  const token = process.env[profile.apiKeyEnv]
  if (!token) throw new Error(`Missing credential environment variable ${profile.apiKeyEnv}`)
  await mkdir(output, { recursive: true, mode: 0o700 })
  await save(join(output, "profile.json"), profile)
  const models = modelHost(profile)
  const imported = job.history
    ? await importHistory({ databasePath, models, history: job.history })
    : []
  await save(join(output, "history-import.json"), imported)
  const capability = randomUUID()
  const headers = { "x-arden-local-capability": capability }
  const resolvedProvider = await benchmarkProvider(profile)
  const transport = resolvedProvider.provider
  await save(join(output, "provider-model.json"), resolvedProvider.catalog)
  const usage = {
    modelRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    budgetExhausted: false
  }
  const metered = (stream) =>
    async function* (request) {
      if (usage.modelRequests >= profile.maxModelRequests) {
        usage.budgetExhausted = true
        throw new Error("Trial model-request budget exhausted")
      }
      usage.modelRequests += 1
      for await (const item of stream(request)) {
        if (typeof item === "object" && item !== null && "usage" in item) {
          usage.promptTokens += item.usage.prompt_tokens ?? 0
          usage.completionTokens += item.usage.completion_tokens ?? 0
          usage.cacheReadTokens += item.usage.cache_read_tokens ?? 0
          usage.cacheWriteTokens += item.usage.cache_write_tokens ?? 0
        }
        yield item
      }
    }
  // The route's own capabilities and sessions (hosted tools, async tools,
  // connection reuse), so a trial runs Arden as the app does; metering is added.
  // Tool search stays only when the profile asks: without it the loop declares
  // every allowed tool up front (every other tool is denied below).
  const provider = {
    protocolVersion: 1,
    ...(transport.capabilities
      ? {
          capabilities: async (model) => {
            const capabilities = await transport.capabilities(model)
            return profile.toolSearch ? capabilities : { ...capabilities, toolSearch: "none" }
          }
        }
      : {}),
    ...(transport.openSession
      ? {
          openSession: async () => {
            const session = await transport.openSession()
            return {
              stream: metered((request) => session.stream(request)),
              close: () => session.close()
            }
          }
        }
      : {}),
    stream: metered((request) => transport.stream(request))
  }
  // The trial is the only local caller; no page ever loads from this origin.
  const localAccess = {
    capability,
    rendererOrigin: "http://127.0.0.1",
    cliCapability: randomUUID()
  }
  const start = () =>
    startServerWithLocalAccess({
      port: 0,
      databasePath,
      provider,
      modelHost: models,
      localAccess,
      // A trial reads no Skills from the host's shared folder, and compacts only
      // when the context fills: the engine's idle compaction would otherwise fire
      // on wall-clock time and make two equal trials differ.
      sharedSkillRoots: [],
      idleCompactionAfterMs: 0
    })
  let server = await start()
  let client = createHeadlessClient({ baseUrl: server.url, headers })
  const interrupted = new AbortController()
  const onSignal = () => interrupted.abort(new Error("Candidate interrupted"))
  process.on("SIGTERM", onSignal)
  process.on("SIGINT", onSignal)
  const signal = AbortSignal.any([deadline, interrupted.signal])
  const send = (path, method, body) =>
    server.fetch(path, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body }),
      signal
    })
  const request = async (path, method = "GET", body) => {
    const response = await send(path, method, body)
    if (!response.ok)
      throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
    return response.json()
  }
  // A chat has no working folder of its own, so every prompt names the task's.
  const prompted = (prompt) =>
    job.nameWorkspace === false
      ? prompt
      : `Your working folder is ${workspace}. Use absolute paths inside it, and pass it as the working directory of every command.\n\n${prompt}`
  // `memory: false` keeps past chats out of the prompt: Memory recall and related
  // chats. The server holds the selection in memory, so each start sends it again.
  const selectContext = (id) =>
    profile.memory
      ? undefined
      : request(
          contextRoutes.experiments(id),
          "PUT",
          JSON.stringify({ ...fullContext, memory: false, threads: false })
        )
  // Answers false for a subject the server keeps no rule for (422): a tool that
  // always asks the owner.
  const rule = async (decision, subject) => {
    const response = await send(
      permissionRoutes.rules,
      "POST",
      JSON.stringify({ list: { kind: "global" }, decision, subject })
    )
    const detail = await response.text()
    if (response.status === 422) return false
    if (!response.ok) throw new Error(`Permission rule: ${response.status} ${detail}`)
    return true
  }
  // Nobody is there to answer a card, so the trial declines it and the model
  // carries on. Three tools always ask (tools-without-rule.json); a connection
  // request asks too.
  const DECLINED = "No one is here to answer this, so it was declined. Carry on without it."
  const declined = []
  const decline = (runId) => async (event) => {
    const data = event.data
    if (data.type !== "approval_needed" && data.type !== "connection_needed") return
    if (declined.some((entry) => entry.toolId === data.tool_id)) return
    const answer = {
      runId: data.run_id ?? runId,
      toolId: data.tool_id,
      result: DECLINED,
      approved: false
    }
    declined.push({ ...answer, kind: data.type, name: data.name ?? data.label })
    if (data.type === "approval_needed") await client.answerApproval(answer)
    else await client.answerConnection({ ...answer, connectionId: data.connection_id })
  }
  let submitted
  let sessionId
  const runs = []
  const db = new DatabaseSync(databasePath, { readOnly: true })
  let baselineRuns = new Set()
  const settle = async () => {
    while (true) {
      signal.throwIfAborted()
      const busy = db
        .prepare(
          "SELECT COUNT(*) AS count FROM chat_runs WHERE status IN ('pending', 'running', 'backgrounded')"
        )
        .get().count
      const deliveries = db
        .prepare("SELECT COUNT(*) AS count FROM automation_deliveries WHERE status = 'pending'")
        .get().count
      if (busy === 0 && deliveries === 0) return
      await sleep(100, undefined, { signal })
    }
  }
  try {
    const automations = await request("/automations")
    // An Automation that is off runs nothing, a run asked for by hand included, so
    // Memory Capture stays on until the history it ingests is captured (below).
    const MEMORY_CAPTURE = "builtin-memory-capture"
    const toggle = (id) => request(`/automations/${encodeURIComponent(id)}/toggle`, "POST")
    for (const automation of automations.automations) {
      if (automation.enabled && !(imported.length && automation.task_id === MEMORY_CAPTURE))
        await toggle(automation.task_id)
    }
    for (const server of profile.mcpServers ?? []) {
      const set = {}
      for (const [name, source] of Object.entries(server.environment)) {
        if (process.env[source] === undefined)
          throw new Error(`Missing ${source} for MCP server ${server.name}`)
        set[name] = process.env[source]
      }
      await request(
        mcpRoutes.collection,
        "POST",
        mcpRequests.create({
          name: server.name,
          transport: {
            type: "stdio",
            command: server.command,
            args: server.args,
            environment: { set, retain: [] },
            cwd: server.cwd
          }
        })
      )
    }
    if (profile.mcpServers?.length) {
      const wanted = new Set(profile.mcpServers.map((server) => server.name))
      while (true) {
        signal.throwIfAborted()
        const servers = mcpDecoders
          .list(await request(mcpRoutes.collection))
          .servers.filter((server) => wanted.has(server.name))
        const failed = servers.find((server) => server.status === "failed")
        if (failed)
          throw new Error(
            `MCP server ${failed.name} failed: ${failed.diagnostics ?? failed.detail}`
          )
        if (
          servers.length === wanted.size &&
          servers.every((server) => server.status === "connected")
        ) {
          await save(join(output, "mcp-servers.json"), servers)
          break
        }
        await sleep(200, undefined, { signal })
      }
    }
    const catalog = toolDecoders.catalog(await request(toolRoutes.catalog))
    const available = new Set(catalog.tools.map((tool) => tool.name))
    for (const tool of profile.tools)
      if (!available.has(tool)) throw new Error(`Unknown profile tool: ${tool}`)
    // A `never` rule keeps a tool out of what the model is offered; the profile's
    // tools get `allow`. The task folder is the one place file tools may change.
    // A tool that always asks the owner takes no rule. A trial has nobody to
    // answer, so a profile may not name one; the rest are listed in the output.
    const alwaysAsk = []
    for (const tool of catalog.tools) {
      const wanted = profile.tools.includes(tool.name)
      if (await rule(wanted ? "allow" : "never", { kind: "tool", tool: tool.name })) continue
      if (wanted) throw new Error(`Profile tool always asks the owner: ${tool.name}`)
      alwaysAsk.push(tool.name)
    }
    await save(join(output, "tools-without-rule.json"), alwaysAsk)
    if (!(await rule("allow", { kind: "path", path: workspace, access: "change" })))
      throw new Error(`The server refused the task folder: ${workspace}`)
    await request(
      "/settings/intelligence",
      "PATCH",
      intelligenceSettingsRequests.update({
        maxAgentDepth: 1,
        maxConcurrentAgents: 1
      })
    )
    await save(join(output, "effective-config.json"), await request("/config"))
    await save(join(output, "tool-catalog.json"), await request(toolRoutes.catalog))
    await save(join(output, "permission-rules.json"), await request(permissionRoutes.rules))
    // The server's own answer on whether a sandboxed command can run here.
    await save(join(output, "command-sandbox.json"), await request(permissionRoutes.commandSandbox))
    if (imported.length) {
      if (!profile.memory) throw new Error("History ingestion requires a memory-enabled profile")
      await request(`/automations/${MEMORY_CAPTURE}/run`, "POST", "{}")
      const db = new DatabaseSync(databasePath, { readOnly: true })
      try {
        while (true) {
          signal.throwIfAborted()
          const pending = db
            .prepare(
              "SELECT COUNT(*) AS count FROM run_sidecars WHERE json_extract(evidence_json, '$.memory_capture.status') = 'pending'"
            )
            .get()
          if (pending.count === 0) break
          await sleep(200, undefined, { signal })
        }
        const captures = db
          .prepare(
            "SELECT run_id, json_extract(evidence_json, '$.memory_capture') AS capture FROM run_sidecars WHERE json_type(evidence_json, '$.memory_capture') = 'object'"
          )
          .all()
        await save(join(output, "memory-capture.json"), captures)
        // `skipped` is a finished capture too: the chat held nothing to keep.
        if (captures.some((row) => !["done", "skipped"].includes(JSON.parse(row.capture).status)))
          throw new Error("Memory capture did not complete successfully")
      } finally {
        db.close()
      }
      await toggle(MEMORY_CAPTURE)
    }
    baselineRuns = new Set(
      db
        .prepare("SELECT run_id FROM chat_runs")
        .all()
        .map((row) => row.run_id)
    )
    const session = await client.createSession({ name: job.id })
    sessionId = session.session_id
    await selectContext(sessionId)
    for (const [index, prompt] of job.prompts.entries()) {
      submitted = await client.submit({
        sessionId,
        clientId: `${job.id}-${index}`,
        message: prompted(prompt),
        approvalMode: "allow"
      })
      await client.wait(submitted, { signal, onEvent: decline(submitted.runId) })
      await settle()
      const latest = db
        .prepare(
          "SELECT run_id FROM chat_runs WHERE session_id = ? ORDER BY started_at DESC, run_id DESC LIMIT 1"
        )
        .get(sessionId)
      const run = await client.getRun(latest.run_id)
      runs.push(run)
      await save(join(output, `run-${index}.json`), run)
      // Which context parts this chat's runs used; the server forgets it on a restart.
      await save(
        join(output, `context-${index}.json`),
        await request(contextRoutes.experiments(sessionId))
      )
      if (run.status !== "completed")
        throw new Error(`Run ended ${run.status}: ${run.error?.message ?? run.stop_reason}`)
      if (job.restartAfter?.includes(index)) {
        await server.stop()
        server = await start()
        client = createHeadlessClient({ baseUrl: server.url, headers })
        await selectContext(sessionId)
        await save(join(output, `restart-${index}.json`), { sessionId, afterRun: run.run_id })
      }
    }
    await save(join(output, "result.json"), {
      id: job.id,
      status: "completed",
      text: runs.at(-1)?.result?.text ?? "",
      runs
    })
  } catch (error) {
    for (const active of db
      .prepare(
        "SELECT run_id FROM chat_runs WHERE status IN ('pending', 'running', 'backgrounded')"
      )
      .all()) {
      await client.cancel({ runId: active.run_id }).catch(() => undefined)
    }
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
      // Preserve native evidence even after timeout; do not reuse the aborted request signal.
      if (sessionId) {
        const exported = await server.fetch(sessionRoutes.export(sessionId, "archive"), { headers })
        if (!exported.ok) throw new Error(`Transcript export failed: ${exported.status}`)
        await save(join(output, "session.json"), await exported.json())
      }
      const trialRows = db
        .prepare("SELECT run_id, session_id FROM chat_runs ORDER BY started_at, run_id")
        .all()
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
        const exported = await server.fetch(sessionRoutes.export(childId, "archive"), { headers })
        if (!exported.ok) throw new Error(`Child transcript export failed: ${exported.status}`)
        await save(join(output, `session-${childId}.json`), await exported.json())
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
        await save(join(output, "usage.json"), usage)
        await save(join(output, "declined-requests.json"), declined)
      } finally {
        process.off("SIGTERM", onSignal)
        process.off("SIGINT", onSignal)
        db.close()
        await server.stop()
      }
    }
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
