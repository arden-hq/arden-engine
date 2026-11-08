import { createToolset } from "@arden-hq/loop"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeApprovalGate } from "../src/tools/approval-gate.js"
import type { ServerTool } from "../src/tools/define.js"
import type { GoogleToolConnections } from "../src/tools/google-accounts.js"
import { mailEditLines } from "../src/tools/google-gmail-edits.js"
import { gmailSendTools } from "../src/tools/google-gmail-send.js"
import { gatePolicy, serverRunContext } from "./kit.js"

import { emptyFileAccess } from "./kit-file-access.js"

const unused = (): never => {
  throw new Error("not used by this test")
}

const ACCOUNT = "me@example.com"
const sent: Array<string> = []
const google: GoogleToolConnections = {
  accounts: () => [],
  request: (request) => {
    if (typeof request.init?.body === "string") {
      const raw: unknown = Reflect.get(JSON.parse(request.init.body), "raw")
      if (typeof raw === "string") sent.push(Buffer.from(raw, "base64url").toString("utf8"))
    }
    return Effect.succeed({
      account: { id: "account-1", email: ACCOUNT, authorizations: [] },
      value: { id: "message-1", threadId: "thread-1" }
    })
  }
}

const tools = gmailSendTools({
  google,
  files: emptyFileAccess,
  emails: [ACCOUNT],
  saveDraft: unused
})
const tool = (name: string): ServerTool => {
  const found = tools.find((candidate) => candidate.definition.name === name)
  if (found === undefined) throw new Error(`missing ${name}`)
  return found
}
const editor = (name: string) => {
  const found = tool(name).approvalEditor
  if (found === undefined) throw new Error(`${name} takes no edits`)
  return found
}

const asked = {
  account_ref: ACCOUNT,
  recipient: "tom@example.com",
  cc: ["ann@example.com"],
  subject: "Thursday",
  body: "Dear Tom,\n\nI would be delighted to meet on Thursday.\n\nKind regards",
  html: false
}

describe("email approval edits", () => {
  it("accepts a new subject and body and keeps every other argument as asked", () => {
    const outcome = editor("email_send").apply(asked, {
      subject: "Thu works",
      body: "Thursday works. See you then"
    })
    expect(outcome).toEqual({
      _tag: "Edited",
      arguments: { ...asked, subject: "Thu works", body: "Thursday works. See you then" }
    })
    expect(editor("email_send").apply(asked, { subject: asked.subject, body: asked.body })).toEqual(
      { _tag: "Unchanged" }
    )
  })

  it("refuses an edit to who the email goes to, from which account, or that breaks its rules", () => {
    const send = editor("email_send")
    const words = { subject: asked.subject, body: asked.body }
    for (const patch of [
      { ...words, recipient: "eve@example.com" },
      { ...words, cc: [] },
      { ...words, account_ref: "other@example.com" },
      { ...words, html: true },
      { subject: "Two\nlines", body: asked.body },
      { subject: asked.subject, body: "" },
      { subject: asked.subject, body: " \n\t " },
      { body: asked.body }
    ]) {
      expect(send.apply(asked, patch)._tag).toBe("Refused")
    }
  })

  it("lets a reply change only its words: the subject comes from the thread", () => {
    const reply = editor("email_reply")
    const replyAsked = {
      message_ref: "gmail:me@example.com:m1",
      body: "Sounds good",
      reply_all: false
    }
    expect(reply.apply(replyAsked, { body: "Works for me" })).toEqual({
      _tag: "Edited",
      arguments: { ...replyAsked, body: "Works for me" }
    })
    expect(reply.apply(replyAsked, { body: "Works", subject: "New" })._tag).toBe("Refused")
    expect(reply.apply(replyAsked, { body: "Works", reply_all: true })._tag).toBe("Refused")
    expect(reply.apply(replyAsked, { body: "  \n" })._tag).toBe("Refused")
  })

  it("keeps both versions whole, so the user's writing sits next to the draft", () => {
    expect(
      mailEditLines(
        { subject: "Thursday", body: "Dear Tom,\nKind regards" },
        { subject: "Thursday", body: "Thu works" }
      )
    ).toEqual([
      { field: "body", label: "Message", from: '"Dear Tom,\nKind regards"', to: '"Thu works"' }
    ])
    expect(mailEditLines({ body: "Same" }, { body: "Same" })).toEqual([])
  })

  it("sends the edited text when the approval carries the user's edits", async () => {
    sent.length = 0
    const run = serverRunContext({
      sessionId: "session-1",
      runId: "run-1",
      policy: {
        budget_id: "run-1",
        budget_generation: 0,
        execution: { mode: "worker", observe: false },
        capabilities: ["all"],
        auto_approve: false,
        google_accounts: null,
        space: null
      },
      approvalMode: "ask",
      codeMode: {
        call: unused,
        changesState: () => false,
        describe: () => undefined,
        scriptFields: () => undefined
      },
      scriptHost: {
        executionProfile: {
          hash: "unused",
          modes: { research: { changesState: false }, code: { changesState: true } }
        },
        agent: unused,
        tool: unused,
        changesState: () => false
      }
    })
    const toolset = createToolset([tool("email_send")], {
      toJsonSchema: () => ({ type: "object" }),
      approvals: () => ({ email_send: "ask" }),
      approvalGate: makeApprovalGate({
        review: async () => ({ verdict: "ask", why: { kind: "failed" } }),
        policy: gatePolicy("ask")
      })
    })(run)
    const edited = { ...asked, subject: "Thu works", body: "Thursday works. See you then" }
    const result = await toolset.execute({
      name: "email_send",
      args: asked,
      toolCallId: "call-1",
      approval: { approved: true, feedback: null, edited: { requested: asked, arguments: edited } }
    })
    expect(sent).toHaveLength(1)
    const [message] = sent
    expect(message).toContain(`Subject: =?UTF-8?B?${Buffer.from("Thu works").toString("base64")}?=`)
    expect(message).toContain("To: tom@example.com")
    expect(message?.endsWith("\r\n\r\nThursday works. See you then")).toBe(true)
    expect(result.data?.["approval_edits"]).toEqual([
      { field: "subject", label: "Subject", from: '"Thursday"', to: '"Thu works"' },
      {
        field: "body",
        label: "Message",
        from: `"${asked.body}"`,
        to: '"Thursday works. See you then"'
      }
    ])
  })
})
