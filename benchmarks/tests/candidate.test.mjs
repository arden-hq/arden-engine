import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "../..")
const modes = ["plain", "memory", "tool", "decline", "restart", "budget", "compaction", "timeout"]
for (const mode of modes)
  test(`real candidate: ${mode}`, { timeout: 60000 }, async () => {
    const withHistory = mode === "memory"
    const directory = await mkdtemp(join(tmpdir(), "arden-benchmark-"))
    const requests = []
    const upstream = createServer(async (req, res) => {
      let body = ""
      for await (const chunk of req) body += chunk
      const request = JSON.parse(body)
      requests.push(request)
      if (mode === "timeout") return
      const offered = (name) => request.tools?.some((tool) => tool.name === name)
      const outputs = request.input.filter((item) => item.type === "function_call_output")
      // The tool call this request answers with, if any. `decline` makes a Space
      // and then archives it: archiving always asks on a card.
      let call
      if (mode === "tool" && outputs.length === 0 && offered("exec_command"))
        call = {
          name: "exec_command",
          input: {
            cmd: "printf verified > benchmark-tool.txt",
            access: "sandbox",
            workdir: join(directory, "workspace")
          }
        }
      if (mode === "decline" && outputs.length === 0 && offered("space_create"))
        call = { name: "space_create", input: { name: "Fixture" } }
      if (mode === "decline" && outputs.length === 1 && offered("space_archive"))
        call = {
          name: "space_archive",
          input: { space_id: /"space_id":"([^"]+)"/.exec(outputs[0].output)?.[1] ?? "" }
        }
      if (call) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        const item = {
          id: `fc-fixture-${outputs.length}`,
          type: "function_call",
          call_id: `fixture-call-${outputs.length}`,
          name: call.name,
          arguments: JSON.stringify(call.input),
          status: "completed"
        }
        for (const event of [
          { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            delta: item.arguments
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "fixture-response",
              status: "completed",
              output: [item],
              usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 }
            }
          }
        ])
          res.write(`data: ${JSON.stringify(event)}\n\n`)
        res.end()
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      const item = {
        id: "fixture-message",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "fixture-ok", annotations: [] }]
      }
      for (const event of [
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, delta: "fixture-ok" },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "fixture-response",
            status: "completed",
            output: [item],
            usage: {
              // Past the compaction trigger, so the compaction mode compacts.
              input_tokens: mode === "compaction" ? 30000 : 7,
              output_tokens: 2,
              total_tokens: 9
            }
          }
        }
      ])
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end()
    })
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const profile = {
      name: "fixture",
      baseUrl: `http://127.0.0.1:${upstream.address().port}`,
      apiKeyEnv: "BENCH_FIXTURE_KEY",
      model: "fixture",
      reasoningEffort: null,
      contextLimit: 32000,
      // The limit counts from the runner's start. Server start and one rule per
      // tool come first; the limit must fall after the chat starts.
      timeoutMs: mode === "timeout" ? 15000 : 40000,
      maxModelRequests: mode === "budget" ? 1 : 30,
      tools: { tool: ["spawn_agent", "exec_command"], decline: ["space_create"] }[mode] ?? [],
      memory: withHistory
    }
    await mkdir(join(directory, "workspace"))
    await writeFile(join(directory, "profile.json"), JSON.stringify(profile))
    await writeFile(
      join(directory, "job.json"),
      JSON.stringify({
        id: "smoke",
        workspace: join(directory, "workspace"),
        output: join(directory, "output"),
        prompts:
          mode === "compaction"
            ? Array.from({ length: 8 }, (_, index) => `Turn ${index}: reply fixture-ok`)
            : [
                "Reply fixture-ok",
                ...(["restart", "budget"].includes(mode) ? ["Reply again"] : [])
              ],
        ...(mode === "restart" ? { restartAfter: [0] } : {}),
        ...(withHistory
          ? {
              history: [
                {
                  id: "past",
                  date: "2025-01-02T12:00:00Z",
                  messages: [
                    { role: "user", content: "My project is Alpha." },
                    { role: "assistant", content: "Understood." }
                  ]
                }
              ]
            }
          : {})
      })
    )
    const run = () =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "benchmarks/candidate.mjs",
            join(directory, "profile.json"),
            join(directory, "job.json")
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              ARDEN_DIR: join(directory, "state"),
              BENCH_FIXTURE_KEY: "fixture-not-a-secret"
            }
          }
        )
        let log = ""
        child.stdout.on("data", (data) => {
          log += data
        })
        child.stderr.on("data", (data) => {
          log += data
        })
        child.once("error", reject)
        child.once("exit", (code) => resolve({ code, log }))
      })
    try {
      const result = await run()
      if (mode === "budget" || mode === "timeout") {
        assert.equal(result.code, 1, result.log)
        assert.equal(
          JSON.parse(await readFile(join(directory, "output/result.json"), "utf8")).status,
          "error"
        )
        if (mode === "budget") {
          assert.ok(requests.length <= 1)
          assert.equal(
            JSON.parse(await readFile(join(directory, "output/usage.json"), "utf8"))
              .budgetExhausted,
            true
          )
        }
        assert.ok(await readFile(join(directory, "output/session.json"), "utf8"))
        return
      }
      assert.equal(result.code, 0, result.log)
      if (mode === "tool") {
        const observed = await readFile(
          join(directory, "workspace/benchmark-tool.txt"),
          "utf8"
        ).catch(() => null)
        assert.equal(
          observed,
          "verified",
          JSON.stringify(
            requests.map((request) => ({
              tools: request.tools?.map((tool) => tool.name),
              outputs: request.input?.filter((item) => item.type === "function_call_output")
            }))
          )
        )
      }
      if (mode === "tool") {
        // Only the profile's tools, the ones no rule can hide, and Arden's own
        // bookkeeping tools reach the model.
        const names = new Set(
          requests.flatMap((request) => request.tools ?? []).map((tool) => tool.name)
        )
        for (const hidden of ["file_write", "web_search", "email_send"])
          assert.ok(!names.has(hidden), `${hidden} was offered`)
      }
      if (mode === "decline") {
        const declined = JSON.parse(
          await readFile(join(directory, "output/declined-requests.json"), "utf8")
        )
        const answers = requests
          .at(-1)
          ?.input.filter((item) => item.type === "function_call_output")
        assert.equal(declined.length, 1, JSON.stringify(answers))
        assert.equal(declined[0].name, "space_archive")
        assert.equal(declined[0].approved, false)
      }
      if (mode === "restart") {
        assert.ok(await readFile(join(directory, "output/restart-0.json"), "utf8"))
        assert.ok(requests.some((request) => JSON.stringify(request.input).includes("fixture-ok")))
      }
      const saved = JSON.parse(await readFile(join(directory, "output/result.json"), "utf8"))
      assert.equal(saved.text, "fixture-ok")
      if (mode === "compaction")
        assert.ok(
          (await readFile(join(directory, "output/session.json"), "utf8")).includes(
            "session_handoff"
          ),
          "Native compaction receipt missing"
        )
      if (withHistory)
        assert.ok(
          (await readFile(join(directory, "output/memory-capture.json"), "utf8")).includes("done")
        )
      // The server's own record of the context each run was built with: Memory
      // and related chats run only when the profile turns memory on.
      const context = JSON.parse(await readFile(join(directory, "output/context-0.json"), "utf8"))
      assert.ok(context.runs.length > 0)
      for (const run of context.runs) {
        assert.equal(run.selection.memory, withHistory)
        assert.equal(run.selection.threads, withHistory)
        const skipped = run.stages
          .filter((stage) => stage.outcome === "skipped")
          .map((stage) => stage.part)
        assert.equal(skipped.includes("memory"), !withHistory, JSON.stringify(run.stages))
      }
      assert.ok(requests.length > 0)
      // The folder sentence leads every prompt.
      assert.ok(
        requests.some((request) => JSON.stringify(request.input).includes("Your working folder is"))
      )
      assert.ok(requests.every((request) => request.model === "fixture"))
      assert.ok(
        (await readFile(join(directory, "output/session.json"), "utf8")).includes("fixture-ok")
      )
      assert.equal((await run()).code, 1)
    } finally {
      upstream.closeAllConnections()
      await new Promise((resolve) => upstream.close(resolve))
      await rm(directory, { recursive: true, force: true })
    }
  })
