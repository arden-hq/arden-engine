import { expect, it } from "vitest"

import { mcpRequests } from "@arden-hq/protocol/mcp"

const transport = {
  type: "stdio",
  command: "npx",
  args: ["-y", "@scope/server"],
  environment: { set: {}, retain: [] }
} as const

it("sends the stored folder, the home folder or an absolute folder", () => {
  const sent = (
    cwd:
      | { readonly kind: "keep" }
      | { readonly kind: "home" }
      | { readonly kind: "folder"; readonly path: string }
  ) => JSON.parse(mcpRequests.create({ name: "local", transport: { ...transport, cwd } }))
  for (const cwd of [
    { kind: "keep" },
    { kind: "home" },
    { kind: "folder", path: "/Users/p/code" }
  ] as const)
    expect(sent(cwd)).toEqual({ name: "local", transport: { ...transport, cwd } })
  expect(() => sent({ kind: "folder", path: "code" })).toThrow()
})
