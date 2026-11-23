import { expect, it } from "vitest"

import { mcpRequests } from "@arden-hq/protocol/mcp"

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
