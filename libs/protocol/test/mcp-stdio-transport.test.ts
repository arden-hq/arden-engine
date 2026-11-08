import { expect, it } from "vitest"

import { mcpDecoders, mcpRequests } from "@arden-hq/protocol/mcp"

const transport = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@scope/server"],
  environment: { set: {}, retain: [] }
} as const

it("sends a working folder only when one is given, and only an absolute one", () => {
  const sent = (cwd?: string | null) =>
    JSON.parse(
      mcpRequests.create({
        name: "local",
        transport: cwd === undefined ? transport : { ...transport, cwd }
      })
    )
  expect(sent()).toEqual({ name: "local", transport })
  expect(sent(null)).toEqual({ name: "local", transport: { ...transport, cwd: null } })
  expect(sent("/Users/p/code")).toEqual({
    name: "local",
    transport: { ...transport, cwd: "/Users/p/code" }
  })
  expect(() => sent("code")).toThrow()
})

it("reads a local server's folder and diagnostics", () => {
  expect(
    mcpDecoders.server({
      name: "local",
      preset_id: null,
      enabled: true,
      status: "failed",
      detail: "The server exited during start: missing [redacted]",
      diagnostics: "Connection closed\n\nstderr:\nmissing [redacted]",
      account_identity: null,
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@scope/server"],
        environment_keys: ["TOKEN"],
        cwd: "/Users/p/code"
      },
      tools: [],
      events: []
    })
  ).toEqual({
    name: "local",
    presetId: null,
    enabled: true,
    status: "failed",
    detail: "The server exited during start: missing [redacted]",
    diagnostics: "Connection closed\n\nstderr:\nmissing [redacted]",
    accountIdentity: null,
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@scope/server"],
      environmentKeys: ["TOKEN"],
      cwd: "/Users/p/code"
    },
    tools: [],
    events: []
  })
})
