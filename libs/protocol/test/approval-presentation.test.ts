import { describe, expect, it } from "vitest"
import { EDITABLE_KIND, sanitizeApprovalPresentation } from "../src/chat/index.js"

const card = (editable: Readonly<Record<string, unknown>>) =>
  sanitizeApprovalPresentation({ title: "Send this reply?", fields: [], editable })?.editable

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
