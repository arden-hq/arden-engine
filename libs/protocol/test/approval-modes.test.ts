import { describe, expect, it } from "vitest"

import { APPROVAL_MODES, commandLineApprovalMode } from "../src/permissions/modes.js"

describe("commandLineApprovalMode", () => {
  it("runs a command-line message in Auto unless it names a mode, and takes every mode", () => {
    expect(commandLineApprovalMode(undefined)).toBe("safe")
    expect(APPROVAL_MODES.map(commandLineApprovalMode)).toEqual([...APPROVAL_MODES])
  })
})
