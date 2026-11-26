import { createHeadlessClient } from "@arden-hq/headless"
import { liveSessions } from "../src/session-list.js"
import { newChat, wholeFork } from "../src/session-requests.js"
import { commandLineRoute } from "@arden-hq/protocol/daemon"
import { describe, expect, it } from "vitest"

import type { CliClient } from "../src/index.js"

const RUN = {
  runId: "run-1",
  sessionId: "session-1",
  clientId: "client-1",
  status: "running"
} as const

const CALLS: Record<keyof CliClient, (client: CliClient) => Promise<unknown>> = {
  answerApproval: (client) =>
    client.answerApproval({
      runId: "run-1",
      toolId: "tool-1",
      result: "",
      decision: { kind: "denied", grant: { kind: "once" } },
      asked: { kind: "unstated" },
      command: { kind: "none" }
    }),
  answerConnection: (client) =>
    client.answerConnection({
      runId: "run-1",
      toolId: "tool-1",
      connectionId: "connection-1",
      result: { kind: "default" },
      approved: true
    }),
  answerQuestion: (client) =>
    client.answerQuestion("question-1", {
      client_id: "client-1",
      answer: { kind: "choice", choice_id: "work" }
    }),
  branchSession: (client) => client.branchSession("session-1", wholeFork),
  cancel: (client) => client.cancel({ kind: "run", runId: "run-1" }),
  createSession: (client) =>
    client.createSession(newChat({ spaceId: undefined, model: undefined })),
  deleteSession: (client) => client.deleteSession("session-1"),
  health: (client) => client.health(),
  listModels: (client) => client.listModels(),
  listSpaces: (client) => client.listSpaces(),
  listSessions: (client) => client.listSessions(liveSessions),
  submit: (client) =>
    client.submit({
      sessionId: "session-1",
      clientId: "client-1",
      message: "hi",
      images: [],
      replyTo: [],
      approvalReply: { kind: "none" },
      approvalMode: { kind: "current" },
      sentFrom: { kind: "typed" },
      capture: { kind: "none" },
      outputSchema: { kind: "free" }
    }),
  wait: (client) => client.wait(RUN, { timeoutMs: 200 }),
  waitForRun: (client) => client.waitForRun("run-1", { timeoutMs: 200 })
}

describe("the routes the CLI calls", () => {
  it("are each on the server's command-line allowlist", async () => {
    const requests: Array<string> = []
    const client = createHeadlessClient({
      baseUrl: "http://arden.test",
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        requests.push(`${init?.method ?? "GET"} ${url.pathname}`)
        return new Response("{}", { status: 400, headers: { "content-type": "application/json" } })
      }
    })
    const silent: Array<string> = []
    for (const [name, call] of Object.entries(CALLS)) {
      const before = requests.length
      await call(client).catch(() => undefined)
      if (requests.length === before) silent.push(name)
    }
    expect(silent).toEqual([])
    const uncovered = requests.filter((request) => {
      const [method = "", path = ""] = request.split(" ")
      return commandLineRoute(method, path) === undefined
    })
    expect(uncovered).toEqual([])
  })
})
