import { PauseRequested, ToolExecutionError, createToolset } from "@arden-hq/loop"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { makeApprovalGate } from "../src/tools/approval-gate.js"
import { defineServerTool } from "../src/tools/define.js"
import type { ServerRunContext } from "../src/tools/run-context.js"
import { gatePolicy, recordOf, serverRunContext } from "./kit.js"

// An approved call runs later in a new toolset: after a pause, the run resumes as a new agent;
// after a card that waits in the chat, the follow-up runs detached. Either way it must know what
// its run had read when it asked, or every tool that changes only what the run has read fails.

const NOTE = "note"

const editNote = defineServerTool({
  name: "edit_note",
  description: "Change the note the run has read",
  parameters: Schema.toStandardSchemaV1(Schema.Struct({})),
  metadata: {
    display_name: "Edit Note",
    kind: "tool",
    action: "write",
    source: "_test",
    effect: "arden_db",
    changes_state: true,
    target: "reported",
    concurrency_group: null,
    destructive: true,
    default_approval: "ask",
    approval_preview: "Change the note."
  },
  approvalPrompt: async () => ({ preview: "Change the note", data: { own: "kept" } }),
  execute: async (_input, ctx) => {
    const read = ctx.run.observations.observed(NOTE)
    if (read === undefined)
      throw new ToolExecutionError("Read the note first", { preview: "Read required" })
    return { result: `changed from ${read}`, data: { approval_data: ctx.approval?.data ?? null } }
  }
})

const toolsetOf = (run: ServerRunContext) =>
  createToolset([editNote], {
    toJsonSchema: () => ({ type: "object" }),
    approvalGate: makeApprovalGate({
      review: async () => ({ verdict: "ask", why: { kind: "judged", reason: "unused" } }),
      policy: gatePolicy("ask")
    })
  })(run)

const askedCard = async (run: ServerRunContext): Promise<PauseRequested> => {
  const asked = await toolsetOf(run)
    .execute({ name: "edit_note", args: {}, toolCallId: "call-1" })
    .then(
      () => undefined,
      (cause: unknown) => cause
    )
  if (!(asked instanceof PauseRequested)) throw new Error("expected an approval card")
  return asked
}

describe("an approved call in a new toolset", () => {
  it("runs with what its run had read when it asked", async () => {
    const asking = serverRunContext()
    asking.observations.observe(NOTE, "v1")
    const card = await askedCard(asking)
    const resumed = await toolsetOf(serverRunContext()).execute({
      name: "edit_note",
      args: {},
      toolCallId: "call-1",
      approval: {
        approved: true,
        feedback: null,
        ...(card.data === undefined ? {} : { data: card.data })
      }
    })
    expect(resumed.content).toBe("changed from v1")
    expect(recordOf(resumed.data)["approval_data"]).toEqual({ own: "kept" })
  })

  it("keeps a newer read the resumed run made itself", async () => {
    const asking = serverRunContext()
    asking.observations.observe(NOTE, "v1")
    const card = await askedCard(asking)
    const later = serverRunContext()
    later.observations.observe(NOTE, "v2")
    const resumed = await toolsetOf(later).execute({
      name: "edit_note",
      args: {},
      toolCallId: "call-1",
      approval: {
        approved: true,
        feedback: null,
        ...(card.data === undefined ? {} : { data: card.data })
      }
    })
    expect(resumed.content).toBe("changed from v2")
  })
})
