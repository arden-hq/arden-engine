import { describe, expect, it } from "vitest"
import { deferred } from "./kit.js"
import {
  createTool,
  createToolset,
  type StandardSchemaV1,
  type ToolApprovalGate
} from "../src/index.js"

const pathArgs: StandardSchemaV1<unknown, { readonly path?: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: value ?? {} })
  }
}

const workspace = createTool({
  name: "workspace",
  description: "Use a workspace",
  parameters: pathArgs,
  metadata: { risk: "high" },
  approvalRequirement: (input) =>
    input.path === undefined
      ? undefined
      : { preview: `Use ${input.path}`, data: { path: input.path } },
  execute: async (input, ctx) =>
    `used:${input.path ?? "default"}${ctx.approval === undefined ? "" : ":approved"}`
})

describe("approval gate", () => {
  it("pauses a call-specific requirement until the host replays an approval", async () => {
    const toolset = createToolset([workspace], { toJsonSchema: () => ({ type: "object" }) })(
      undefined
    )

    await expect(
      toolset.execute({ name: "workspace", args: { path: "/outside" }, toolCallId: "1" })
    ).rejects.toMatchObject({
      reason: "approval",
      detail: "Use /outside",
      data: { path: "/outside" }
    })
    await expect(
      toolset.execute({
        name: "workspace",
        args: { path: "/outside" },
        toolCallId: "1",
        approval: { approved: true, feedback: null, data: { path: "/outside" } }
      })
    ).resolves.toMatchObject({ content: "used:/outside:approved", is_error: false })
    await expect(
      toolset.execute({ name: "workspace", args: {}, toolCallId: "2" })
    ).resolves.toMatchObject({ content: "used:default", is_error: false })
  })

  it("still runs the requirement on a replayed call, so it can refuse it", async () => {
    const guarded = createTool({
      name: "guarded",
      description: "Refuses one path",
      parameters: pathArgs,
      metadata: {},
      approvalRequirement: (input) => {
        if (input.path === "/refused") throw new Error("refused by the requirement")
        return { preview: "Use it?" }
      },
      execute: async () => "ran"
    })
    const toolset = createToolset([guarded], { toJsonSchema: () => ({ type: "object" }) })(
      undefined
    )

    await expect(
      toolset.execute({
        name: "guarded",
        args: { path: "/refused" },
        toolCallId: "r",
        approval: { approved: true, feedback: null }
      })
    ).rejects.toThrow("refused by the requirement")
  })

  it("pauses an ask decision on the tool's own prompt, or its description", async () => {
    const toolset = createToolset([workspace], {
      toJsonSchema: () => ({ type: "object" }),
      approvals: () => ({ workspace: "ask" })
    })(undefined)

    await expect(
      toolset.execute({ name: "workspace", args: {}, toolCallId: "3" })
    ).rejects.toMatchObject({ reason: "approval", detail: "Use a workspace" })
  })

  it("hands the host gate the validated call and lets it run and shape the result", async () => {
    const seen: Array<{
      readonly input: unknown
      readonly decision: string
      readonly risk: string
    }> = []
    const gate: ToolApprovalGate<void, { readonly risk: string }> = async (call, execute) => {
      seen.push({ input: call.input, decision: call.decision, risk: call.definition.metadata.risk })
      const result = await execute({ ...call.ctx, approval: { approved: true, feedback: null } })
      return { ...result, data: { ...result.data, granted_by: "host" } }
    }
    const toolset = createToolset([workspace], {
      toJsonSchema: () => ({ type: "object" }),
      approvals: () => ({ workspace: "ask" }),
      approvalGate: gate
    })(undefined)

    await expect(
      toolset.execute({ name: "workspace", args: { path: "/tmp" }, toolCallId: "4" })
    ).resolves.toMatchObject({ content: "used:/tmp:approved", data: { granted_by: "host" } })
    expect(seen).toEqual([{ input: { path: "/tmp" }, decision: "ask", risk: "high" }])
  })
})

it("rechecks pending input after approval before starting the tool effect", async () => {
  const waiting = deferred()
  const approved = deferred()
  let pending = false
  let executions = 0
  const tool = createTool({
    name: "write",
    metadata: {},
    description: "Write",
    parameters: pathArgs,
    execute: async () => {
      executions += 1
      return "written"
    }
  })
  const toolset = createToolset([tool], {
    toJsonSchema: () => ({}),
    approvalGate: async (call, execute) => {
      waiting.resolve()
      await approved.promise
      return execute(call.ctx)
    }
  })(undefined)
  const running = toolset.execute({
    name: "write",
    args: {},
    toolCallId: "waiting-write",
    beforeExecute: async () =>
      pending
        ? { content: "Input pending", preview: "Input pending", is_error: true, retryable: true }
        : undefined
  })
  await waiting.promise
  pending = true
  approved.resolve()
  const result = await running
  expect(executions).toBe(0)
  expect(result).toMatchObject({ is_error: true, retryable: true })
})
