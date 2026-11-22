import type { RunApproval } from "@arden-hq/protocol/runs"
import type { ToolDisplay } from "@arden-hq/protocol/tools"
import { expect, it } from "vitest"
import { mobileAsks } from "../src/mobile/asks.js"
import { runCommand } from "../src/relay/commands.js"
import type { Loopback } from "../src/relay/ports.js"

const approval = (toolCallId: string, toolName: string): RunApproval => ({
  at: "2026-11-21T09:00:00.000Z",
  run_id: "run-1",
  session_id: "chat-1",
  destination_session_id: "chat-1",
  work: null,
  tool_call_id: toolCallId,
  kind: "tool_approval",
  connection: null,
  tool_name: toolName,
  action: "execute",
  scope: "run",
  preview: `Use ${toolName}`,
  description: null,
  detail: null,
  subject: null,
  reason: null,
  presentation: null,
  diff: null,
  rule_places: []
})

const displays: Readonly<Record<string, ToolDisplay>> = {
  vault_pay: { card: "vault_card_pay" },
  vault_allow_payment_frame: { card: "vault_card_frame" },
  vault_ask_key: { card: "vault_key_ask" },
  browser_ask_secret: { card: "site_secret" },
  vault_use_key: { card: "vault_key_use" },
  exec_command: { card: "command", refresh: "terminals" }
}

it("the phone is offered no card only the Arden app can answer", () => {
  const asks = mobileAsks({
    questions: [],
    approvals: Object.keys(displays).map((name) => approval(name, name)),
    places: new Map([
      ["chat-1", { name: "My chat", spaceId: undefined, home: false, onboarding: false }]
    ]),
    spaceNames: new Map(),
    displayOf: (name) => displays[name]
  })
  expect(asks.flatMap((ask) => (ask.kind === "approval" ? [ask.tool_id] : []))).toEqual([
    "vault_use_key",
    "exec_command"
  ])
})

const engine = (answer: { readonly status: number; readonly body: unknown }) => {
  const requests: Array<{
    readonly method: string
    readonly path: string
    readonly body: unknown
  }> = []
  const loopback: Loopback = {
    request: async ({ method, path, body }) => {
      requests.push({ method, path, body })
      if (method === "GET" && path === "/mobile/home") return { status: 500, body: null }
      if (method === "POST" && path === "/tools/result") return answer
      return { status: 404, body: null }
    },
    events: async function* () {}
  }
  return { loopback, requests }
}

const decide = (loopback: Loopback, cid: string) =>
  runCommand(loopback, cid, {
    kind: "decide",
    args: { run_id: "run-1", tool_id: "call-1", approve: true }
  })

it("a phone decision goes to the engine as it came, and its answer is the result", async () => {
  const settled = engine({ status: 200, body: { status: "ok" } })
  expect(await decide(settled.loopback, "cid-1")).toEqual({
    state: "done",
    result: { status: "ok" }
  })
  expect(settled.requests).toEqual([
    {
      method: "POST",
      path: "/tools/result",
      body: { run_id: "run-1", tool_id: "call-1", result: "", approved: true, command_id: "cid-1" }
    }
  ])
  const otherwise = engine({ status: 409, body: null })
  expect(await decide(otherwise.loopback, "cid-2")).toEqual({
    state: "rejected",
    result: { message: "That was already handled." }
  })
})
