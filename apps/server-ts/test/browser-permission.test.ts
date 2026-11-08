import { describe, expect, it } from "vitest"
import { sitePermissionDecision } from "../src/tools/browser-permission.js"

describe("sitePermissionDecision", () => {
  it("asks for location on a card in Ask and Auto", () => {
    for (const mode of ["ask", "safe"] as const) {
      expect(
        sitePermissionDecision({ mode, permissions: ["location"], approval: undefined })
      ).toEqual({ kind: "ask" })
    }
  })

  it("never raises a card for camera or microphone, in any mode, even after an approval", () => {
    for (const mode of ["ask", "safe", "allow", "read_only"] as const) {
      for (const permissions of [["camera"], ["microphone"], ["location", "microphone"]] as const) {
        for (const approval of [undefined, { always: false }, { always: true }]) {
          expect(sitePermissionDecision({ mode, permissions, approval })).toEqual({
            kind: "deny",
            reason: "deferred"
          })
        }
      }
    }
  })

  it("never shows a card in Never ask, and denies instead of granting", () => {
    expect(
      sitePermissionDecision({ mode: "allow", permissions: ["location"], approval: undefined })
    ).toEqual({ kind: "deny", reason: "never_ask" })
    expect(
      sitePermissionDecision({ mode: "read_only", permissions: ["location"], approval: undefined })
    ).toEqual({ kind: "deny", reason: "read_only" })
  })

  it("an approved card allows once, or always for this site only when the user chose it", () => {
    expect(
      sitePermissionDecision({
        mode: "safe",
        permissions: ["location"],
        approval: { always: false }
      })
    ).toEqual({ kind: "answer", answer: "once" })
    expect(
      sitePermissionDecision({ mode: "ask", permissions: ["location"], approval: { always: true } })
    ).toEqual({ kind: "answer", answer: "always" })
  })
})
