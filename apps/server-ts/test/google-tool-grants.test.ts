import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import type { GoogleAccount } from "@arden-hq/protocol/google"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { emptyFileAccess } from "./kit-file-access.js"

import type { GoogleToolConnections } from "../src/tools/google-accounts.js"
import { makeCalendarTools } from "../src/tools/google-calendar.js"
import { gmailDraftTool } from "../src/tools/google-gmail-draft.js"
import { gmailModifyTools } from "../src/tools/google-gmail-modify.js"
import { threadRef } from "../src/tools/google-gmail-refs.js"
import { defineGoogleTool } from "../src/tools/google-tool-grant.js"
import type { ServerRunContext } from "../src/tools/run-context.js"
import { serverRunContext } from "./kit.js"

const ME = "me@example.com"
const TEAM = "team@group.calendar.google.com"
const ctx = (): ToolContext<ServerRunContext> => ({
  run: serverRunContext(),
  signal: new AbortController().signal,
  toolCallId: "grant-call",
  messages: []
})
const connected = (scopes: readonly string[] = []): GoogleAccount => ({
  id: "acct-1",
  email: ME,
  authorizations: [
    { service: "gmail", status: "ready", scopes },
    { service: "calendar", status: "ready", scopes }
  ]
})

const cases = [
  {
    name: "email_draft",
    grant: "gmail_drafts",
    input: { account_ref: ME, to: ["tom@example.com"], body: "Hello" }
  },
  {
    name: "email_update",
    grant: "gmail_modify",
    input: { account_ref: ME, thread_refs: [threadRef(ME, "thread-1")], read: true }
  },
  {
    name: "email_update",
    grant: "gmail_modify",
    input: {
      account_ref: ME,
      restore: [{ message_ids: ["m1"], add_labels: ["UNREAD"], remove_labels: [] }]
    }
  },
  {
    name: "email_trash",
    grant: "gmail_modify",
    input: { account_ref: ME, thread_refs: [threadRef(ME, "thread-1")] }
  },
  { name: "calendar_list_calendars", grant: "calendar_list", input: {} },
  {
    name: "calendar_free_busy",
    grant: "calendar_freebusy",
    input: {
      account_ref: ME,
      calendars: ["primary"],
      time_min: "2026-10-15T09:00:00Z",
      time_max: "2026-10-15T10:00:00Z"
    }
  },
  {
    name: "calendar_create_event",
    grant: "calendar_list",
    input: {
      account_ref: ME,
      calendar_id: TEAM,
      title: "Meeting",
      start: "2026-10-15T09:00:00Z",
      end: "2026-10-15T10:00:00Z",
      attendees: []
    }
  },
  {
    name: "calendar_edit_event",
    grant: "calendar_list",
    input: { event_ref: `${ME}:evt-1`, calendar_id: TEAM, title: "Updated" }
  },
  {
    name: "calendar_delete_event",
    grant: "calendar_list",
    input: { event_ref: `${ME}:evt-1`, calendar_id: TEAM }
  },
  {
    name: "calendar_respond",
    grant: "calendar_list",
    input: { event_ref: `${ME}:evt-1`, calendar_id: TEAM, response: "accepted" }
  }
] as const

const googleFixture = () => {
  const accounts = [connected()]
  const requests: { method: string; url: string }[] = []
  const google: GoogleToolConnections = {
    accounts: () => accounts,
    request: (request) => {
      requests.push({ method: request.init?.method ?? "GET", url: request.url })
      const value = request.url.includes("/threads/")
        ? {
            id: "thread-1",
            messages: [
              {
                id: "m1",
                labelIds: ["UNREAD"],
                payload: { headers: [{ name: "Subject", value: "Hello" }] }
              }
            ]
          }
        : {
            id: "evt-1",
            summary: "Meeting",
            start: { dateTime: "2026-10-15T09:00:00Z" },
            end: { dateTime: "2026-10-15T10:00:00Z" },
            organizer: { email: "organizer@example.com" },
            attendees: [{ email: ME, self: true, responseStatus: "needsAction" }]
          }
      return Effect.succeed({ account: accounts[0] ?? connected(), value })
    }
  }
  const tools = [
    ...makeCalendarTools({ google }),
    ...gmailModifyTools({ google, emails: [ME] }),
    gmailDraftTool({ google, files: emptyFileAccess, emails: [ME] })
  ]
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.definition.name === name)
    if (found === undefined) throw new Error(`Missing tool ${name}`)
    return found
  }
  return { google, accounts, requests, tool }
}

describe("declared Google grants", () => {
  it.each(cases)(
    "$name requires $grant on both consent and execution",
    async ({ name, grant, input }) => {
      const { tool, requests } = googleFixture()
      const call = tool(name)
      const context = ctx()
      const card = await call.definition.approvalRequirement?.(input, context)
      expect(card?.data?.["reviewer"]).toBe("user")
      expect(card?.presentation).toMatchObject({ needs_grant: { grant, account: ME } })
      requests.length = 0
      await expect(
        call.definition.execute(input, { ...context, approval: { approved: true, feedback: null } })
      ).rejects.toBeInstanceOf(ToolExecutionError)
      expect(requests).toEqual([])
    }
  )

  it.each(
    cases.filter(
      ({ name }) =>
        name.startsWith("calendar_") &&
        !["calendar_list_calendars", "calendar_free_busy"].includes(name)
    )
  )("$name needs no list consent on the primary calendar", async ({ name, input }) => {
    const { tool, requests } = googleFixture()
    expect(
      await tool(name).definition.approvalRequirement?.({ ...input, calendar_id: "primary" }, ctx())
    ).toBeUndefined()
    expect(requests).toEqual([])
  })

  it("checks the live account after approval, and permits execution only while the grant is held", async () => {
    const { google, accounts, requests } = googleFixture()
    const tool = defineGoogleTool({
      google,
      grant: {
        grant: "gmail_drafts",
        what: "save drafts",
        note: "Allow drafts",
        target: (input) => ({ accountRef: input.account_ref })
      },
      name: "save_probe",
      description: "Save a draft",
      parameters: Schema.toStandardSchemaV1(Schema.Struct({ account_ref: Schema.String })),
      metadata: {
        effect: "none",
        display_name: "Probe",
        kind: "tool",
        action: "read",
        source: "gmail",
        changes_state: false,
        concurrency_group: null,
        destructive: false
      },
      execute: async () => "saved"
    })
    const input = { account_ref: ME }
    accounts[0] = connected(["https://www.googleapis.com/auth/gmail.compose"])
    expect(await tool.definition.approvalRequirement?.(input, ctx())).toBeUndefined()
    expect(await tool.execute(input, ctx(), { decision: "approve" })).toMatchObject({
      content: "saved"
    })
    accounts[0] = connected()
    await expect(tool.execute(input, ctx(), { decision: "approve" })).rejects.toMatchObject({
      reason: "approval"
    })
    await expect(
      tool.execute(input, { ...ctx(), approval: { approved: true, feedback: null } })
    ).rejects.toBeInstanceOf(ToolExecutionError)
    expect(requests).toEqual([])
  })
})
