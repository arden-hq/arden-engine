import type { RunApproval } from "@arden-hq/protocol/runs"
import type { ToolDisplay } from "@arden-hq/protocol/tools"
import { RunQuestionAnswerSchema } from "@arden-hq/protocol/effect/runs"
import { Predicate, Schema } from "effect"
import { expect, it } from "vitest"
import { mobileAsks } from "../src/mobile/asks.js"
import { runCommand } from "../src/relay/commands.js"
import type { Loopback } from "../src/relay/ports.js"

const approval = (toolCallId: string, toolName: string): RunApproval => ({
  at: "2026-11-21T09:00:00.000Z",
  run_id: "run-1",
  session_id: "chat-1",
  destination_session_id: "chat-1",
  asker: { kind: "chat" },
  tool_call_id: toolCallId,
  decision_delivery: "blocking",
  kind: "tool_approval",
  connection: { kind: "none" },
  tool_name: toolName,
  action: "execute",
  preview: { kind: "preview", text: `Use ${toolName}` },
  description: { kind: "none" },
  detail: { kind: "none" },
  subject: { kind: "none" },
  card: { kind: "plain" },
  diff: { kind: "no_diff" },
  rule_places: [],
  can_attach_folder_to_space: false,
  grant_folder: { kind: "none" }
})

const displays: Readonly<Record<string, ToolDisplay>> = {
  vault_pay: [{ fact: "card", value: "vault_card_pay" }],
  vault_allow_payment_frame: [{ fact: "card", value: "vault_card_frame" }],
  vault_ask_key: [{ fact: "card", value: "vault_key_ask" }],
  browser_ask_secret: [{ fact: "card", value: "site_secret" }],
  vault_use_key: [{ fact: "card", value: "vault_key_use" }],
  exec_command: [
    { fact: "card", value: "command" },
    { fact: "refresh", value: "terminals" }
  ]
}

it("the phone is offered no card only the Arden app can answer", () => {
  const asks = mobileAsks({
    questions: [],
    approvals: [
      ...Object.keys(displays).map((name) => approval(name, name)),
      { ...approval("connect", "exec_command"), kind: "integration_connection" }
    ],
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

const decide = (loopback: Loopback, cid: string, approve = true) =>
  runCommand(loopback, cid, {
    kind: "decide",
    args: { run_id: "run-1", tool_id: "call-1", approve }
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
  expect((await decide(otherwise.loopback, "cid-2")).state).toBe("rejected")
  const denied = engine({ status: 200, body: { status: "ok" } })
  await decide(denied.loopback, "cid-3", false)
  expect(denied.requests[0]?.body).toMatchObject({ approved: false })
})

it("a phone answer with several choices and words reaches the engine as an answer it accepts", async () => {
  const requests: Array<unknown> = []
  const loopback: Loopback = {
    request: async ({ body }) => {
      requests.push(body)
      return { status: 200, body: { status: "ok" } }
    },
    events: async function* () {}
  }
  await runCommand(loopback, "cid-answer", {
    kind: "answer",
    args: { question_id: "q-1", text: " and soon ", option_ids: ["a", "b"] }
  })
  const [sent] = requests
  const answer = Predicate.isObject(sent) ? sent["answer"] : undefined
  expect(Schema.decodeUnknownSync(RunQuestionAnswerSchema)(answer)).toEqual({
    kind: "choices",
    choice_ids: ["a", "b"],
    typed: { kind: "given", text: "and soon" }
  })
})
