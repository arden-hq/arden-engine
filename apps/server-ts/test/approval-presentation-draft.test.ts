import { describe, expect, it } from "vitest"
import { EDITABLE_KIND } from "@arden-hq/protocol/chat"
import { storedApprovalPresentation } from "../src/persistence/tools/approval-draft.js"

const card = (editable: Readonly<Record<string, unknown>>) =>
  storedApprovalPresentation({ title: "Send this reply?", fields: [], editable })?.editable

describe("an approval card's editable mail", () => {
  it("keeps the account a mail draft is saved to", () => {
    expect(
      card({ fields: ["body"], arguments: { body: "Hi" }, account: "me@example.com" })
    ).toEqual({
      kind: EDITABLE_KIND.mailDraft,
      fields: ["body"],
      arguments: { body: "Hi" },
      account: "me@example.com"
    })
  })

  it("reads a card stored before the account as one that saves no draft", () => {
    expect(card({ fields: ["body"], arguments: { body: "Hi" } })).toEqual({
      kind: EDITABLE_KIND.arguments,
      fields: ["body"],
      arguments: { body: "Hi" }
    })
  })
})

it("reads a stored card with no edits as fixed and its absent parts as tagged states", () => {
  expect(storedApprovalPresentation({ title: "Run it?", fields: [] })).toEqual({
    attachments: [],
    title: "Run it?",
    subject: { kind: "none" },
    fields: [],
    body: { kind: "none" },
    approve_label: { kind: "none" },
    reject_label: { kind: "none" },
    note: { kind: "none" },
    why: { kind: "none" },
    grant_label: { kind: "none" },
    grant_rule: { kind: "none" },
    needs_grant: { kind: "none" },
    editable: { kind: EDITABLE_KIND.fixed },
    image: { kind: "none" }
  })
})
