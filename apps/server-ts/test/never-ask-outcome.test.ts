import { expect, it } from "vitest"
import { APPROVAL_MODES } from "@arden-hq/protocol/permissions"
import { personCard, skipsCards, waivesRequirement } from "../src/execution/decide.js"

it("shows a tool's own card in Ask and Auto, skips a waivable one in Never ask, and refuses a card only the person fills outside Ask and Auto", () => {
  expect(
    Object.fromEntries(
      APPROVAL_MODES.map((mode) => [
        mode,
        {
          skips: skipsCards(mode),
          bypassTool: waivesRequirement(mode, { approval_bypass: true }),
          alwaysAskTool: waivesRequirement(mode, { approval_bypass: true, always_ask: true }),
          plainTool: waivesRequirement(mode, {}),
          personCard: personCard(mode)
        }
      ])
    )
  ).toEqual({
    read_only: {
      skips: false,
      bypassTool: false,
      alwaysAskTool: false,
      plainTool: false,
      personCard: "read_only"
    },
    ask: {
      skips: false,
      bypassTool: false,
      alwaysAskTool: false,
      plainTool: false,
      personCard: "ask"
    },
    safe: {
      skips: false,
      bypassTool: false,
      alwaysAskTool: false,
      plainTool: false,
      personCard: "ask"
    },
    allow: {
      skips: true,
      bypassTool: true,
      alwaysAskTool: false,
      plainTool: false,
      personCard: "never_ask"
    }
  })
})
