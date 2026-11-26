import { expect, it } from "vitest"
import { toolsetFor } from "./tool-approval-gate-kit.js"

it("does not execute an allowance returned after cancellation", async () => {
  const controller = new AbortController()
  const { toolset } = toolsetFor({
    mode: "safe",
    verdict: async () => {
      controller.abort(new Error("cancelled"))
      return { verdict: "allow", reason: "Authorized" }
    }
  })
  await expect(
    toolset.execute({
      name: "workspace",
      args: { path: "/tmp/project" },
      toolCallId: "cancel",
      signal: controller.signal
    })
  ).rejects.toThrow("cancelled")
})
