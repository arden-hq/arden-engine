import { expect, it } from "vitest"
import { terminalDecoders } from "@arden-hq/protocol/sessions/terminals"

it("decodes a terminal started with network access", () => {
  const terminal = {
    id: 1,
    tool_call_id: "call-1",
    command: "npm install",
    cwd: "/tmp",
    access: "network",
    tty: false,
    started_at: "2026-11-24T10:00:00.000Z",
    cursor: 0,
    state: "running"
  }
  expect(terminalDecoders.list({ terminals: [terminal] }).terminals[0]?.access).toBe("network")
})
