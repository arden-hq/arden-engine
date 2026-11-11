import { mkdir, readFile, writeFile, realpath, stat } from "node:fs/promises"
import { resolve, join, relative, isAbsolute } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as sleep } from "node:timers/promises"
import { Schema } from "effect"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { readProfile, modelHost, modelSettings } from "./profile.mjs"
import { createHeadlessClient } from "../libs/headless/dist/index.js"
import { contextRoutes } from "../libs/protocol/dist/context/index.js"
import { permissionRoutes } from "../libs/protocol/dist/permissions/index.js"
import { toolRoutes } from "../libs/protocol/dist/tools/index.js"
import { sessionRoutes } from "../libs/protocol/dist/sessions/index.js"
import { errorMessage } from "../libs/std/dist/errors.js"
import { importHistory } from "./history.mjs"

// The server's own entry file; the runner starts it and imports none of it.
const SERVER_ENTRY = fileURLToPath(new URL("../apps/server-ts/dist/main.js", import.meta.url))

const Job = Schema.Struct({
  id: Schema.NonEmptyString,
  workspace: Schema.NonEmptyString,
  output: Schema.NonEmptyString,
  prompts: Schema.NonEmptyArray(Schema.NonEmptyString),
  // A folder of Skills the task itself ships; each one is a folder with SKILL.md.
  skills: Schema.optionalKey(Schema.NonEmptyString),
  // False sends each prompt as written, for a suite whose task uses no files.
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
  // An Automation that is off runs nothing, a run asked for by hand included, so
  // Memory Capture stays on until the history it ingests is captured (below).
  const MEMORY_CAPTURE = "builtin-memory-capture"
  // The trial as a settings file: everything Arden is told is in it. The key is
  // not; the file names the variable that holds it.
  const settings = {
    dataDirectory: stateRoot,
    ...modelSettings(profile),
    maxModelRequests: profile.maxModelRequests,
    // Without tool search the loop declares every allowed tool up front, as
    // other harnesses present a benchmark's tools.
    toolSearch: profile.toolSearch === true,
    ...(profile.tools ? { tools: profile.tools } : { blockedTools: profile.blockedTools }),
    // The task folder is the one place file tools may change.
    workspace,
    // `memory: false` keeps past chats out of every prompt: Memory recall and related chats.
    memory: profile.memory,
    automations: false,
    ...(imported.length ? { keepAutomations: [MEMORY_CAPTURE] } : {}),
    ...(profile.mcpServers ? { mcpServers: profile.mcpServers } : {}),
    // A trial reads the task's own Skills only, never the host's shared folder,
    // and compacts only when the context fills: idle compaction would fire on
    // wall-clock time and make two equal trials differ.
    skillRoots: job.skills === undefined ? [] : [job.skills],
    idleCompactionAfterMs: 0,
    ...(profile.commandSandbox === false ? { commandSandbox: false } : {}),
    // Nobody is there to answer a card.
    approvalMode: "allow"
  }
  const settingsFile = join(output, "settings.json")
  await save(settingsFile, settings)
  const interrupted = new AbortController()
  const onSignal = () => interrupted.abort(new Error("Candidate interrupted"))
  process.on("SIGTERM", onSignal)
  process.on("SIGINT", onSignal)
  const signal = AbortSignal.any([deadline, interrupted.signal])
  // Arden runs as its own process, started from the settings file and reached
  // over HTTP with the secret in its access file, as any outside driver would.
  const start = async () => {
    const child = spawn(process.execPath, [SERVER_ENTRY, "--config", settingsFile], {
      stdio: ["ignore", "pipe", "inherit"]
    })
    const stop = () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        const kill = setTimeout(() => child.kill("SIGKILL"), 10_000)
        child.once("exit", () => {
          clearTimeout(kill)
          resolve()
        })
        child.kill("SIGTERM")
      })
    const ready = await new Promise((resolve, reject) => {
      let line = ""
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk) => {
        line += chunk
        if (line.includes("\n")) resolve(JSON.parse(line.slice(0, line.indexOf("\n"))))
      })
      child.once("error", reject)
      child.once("exit", (code) => reject(new Error(`Arden did not start (exit ${code})`)))
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    }).catch(async (error) => {
      await stop()
      throw error
    })
    const access = JSON.parse(await readFile(ready.accessFile, "utf8"))
    const headers = { "x-arden-local-capability": access.capability }
    return {
      ready,
      headers,
      stop,
      fetch: (path, init) => fetch(new URL(path, ready.url), init),
      client: createHeadlessClient({ baseUrl: ready.url, headers })
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
    return response.json()
  }
  // A chat has no working folder of its own, so every prompt names the task's.
  const prompted = (prompt) =>
    `Your working folder is ${workspace}. Use absolute paths inside it, and pass it as the working directory of every command.\n\n${prompt}`
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
  let baselineRuns = new Set()
  // The server's own word on whether anything is still going: a Run, or an
  // Automation delivery that will start one.
  const settle = async () => {
    while (true) {
      signal.throwIfAborted()
      if ((await client.listRuns()).idle) return
      await sleep(100, undefined, { signal })
    }
  }
  try {
    const toggle = (id) => request(`/automations/${encodeURIComponent(id)}/toggle`, "POST")
    if (profile.mcpServers?.length)
      await save(join(output, "mcp-servers.json"), (await request("/mcp/servers")).servers)
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
    baselineRuns = new Set((await client.listRuns()).runs.map((run) => run.run_id))
    const session = await client.createSession({ name: job.id })
    sessionId = session.session_id
    for (const [index, prompt] of job.prompts.entries()) {
      submitted = await client.submit({
        sessionId,
        clientId: `${job.id}-${index}`,
        message: prompted(prompt)
      })
      await client.wait(submitted, { signal, onEvent: decline(submitted.runId) })
      await settle()
      // A message sent mid-run joins that Run; a queued one starts another. The
      // chat's last Run is the one that answered.
      const latest = (await client.listRuns()).runs.findLast((run) => run.session_id === sessionId)
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
        client = server.client
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
    const listed = await client.listRuns().catch(() => ({ runs: [] }))
    for (const active of listed.runs.filter((run) => run.active))
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
      // Preserve native evidence even after timeout; do not reuse the aborted request signal.
      if (sessionId) {
        const exported = await server.fetch(sessionRoutes.export(sessionId, "archive"), {
          headers: server.headers
        })
        if (!exported.ok) throw new Error(`Transcript export failed: ${exported.status}`)
        await save(join(output, "session.json"), await exported.json())
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
        // The server keeps the trial's model requests and tokens in its data folder.
        await save(
          join(output, "usage.json"),
          JSON.parse(await readFile(server.ready.usageFile, "utf8"))
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
