import { Schema } from "effect"
import {
  PauseRequested,
  ToolExecutionError,
  createTool,
  createToolset,
  failedToolResult,
  type ToolCallRequest,
  type ToolResult,
  type Toolset
} from "@arden-hq/loop"
import { expect, it } from "vitest"

import type { ChatRunnerToolRequest } from "../src/chat/runner-contract.js"
import { TOOL_DISPLAY_TITLE } from "../src/execution/tool-call-presentation.js"
import { localizeOutputs } from "../src/tools/localize-outputs.js"
import { withMiddleware } from "../src/execution/toolset-middleware.js"
import { makeCodeModeHost } from "../src/tools/code-mode-host.js"
import { defineServerTool } from "../src/tools/define.js"
import { claimObservedRevision } from "../src/tools/browser-support.js"
import { makeBrowserObservationRegistry } from "../src/tools/run-context.js"
import { serverRunContext } from "./kit.js"
import { PersistedToolResultSchema } from "../src/persistence/sqlite/tool-rows.js"

it("invalidates browser authority when a recovered call failed before reporting its page", async () => {
  const tab = "browser-tab-4-3afbbbf5"
  const observations = makeBrowserObservationRegistry({ newRef: () => "snap-abcdef" })
  observations.observe(tab, 3, { "@e1": "Save" }, "https://example.test")
  const tool = defineServerTool({
    name: "browser_act",
    description: "Act on the page",
    parameters: Schema.toStandardSchemaV1(Schema.Struct({ tab_ref: Schema.String })),
    metadata: {
      effect: "external",
      code_mode: true,
      display_name: "Act on the page",
      kind: "write",
      action: "write",
      source: "_browser",
      changes_state: true,
      target: "reported",
      concurrency_group: null,
      destructive: false
    },
    execute: async () => {
      throw new Error("A completed call must not run again")
    }
  })
  const run = serverRunContext({
    executeTool: async () => failedToolResult(new ToolExecutionError("Action failed"))
  })
  const toolset = createToolset([tool], { toJsonSchema: () => ({}) })(run)
  const host = makeCodeModeHost({
    run,
    tools: [tool],
    scope: new Set(["browser_act"]),
    toolset: () => toolset,
    browserObservations: observations
  })
  await expect(
    host.call({
      toolCallId: "script:code:failed",
      name: "browser_act",
      args: { tab_ref: tab },
      signal: new AbortController().signal,
      detached: false,
      messages: []
    })
  ).rejects.toBeInstanceOf(ToolExecutionError)
  expect(() => claimObservedRevision(observations, tab, "snap-abcdef", "next-act")).toThrow(
    ToolExecutionError
  )
})

it.each(["snapshot", "action-page"] as const)(
  "restores a cached %s with its original one-use browser revision",
  async (kind) => {
    const tab = "browser-tab-4-3afbbbf5"
    const saved = new Map<string, ToolResult>()
    const executed: string[] = []
    const bind = () => {
      const observations = makeBrowserObservationRegistry({ newRef: () => "snap-abcdef" })
      const run = serverRunContext({
        browserObservations: observations,
        executeTool: async (request, operation) => {
          const replay = saved.get(request.toolCallId)
          if (replay !== undefined) return replay
          const result = await operation()
          const persisted = Schema.decodeUnknownSync(PersistedToolResultSchema)(result)
          saved.set(request.toolCallId, JSON.parse(JSON.stringify(persisted)))
          return result
        }
      })
      const tool = defineServerTool({
        name: "browser_snapshot",
        description: "Read the page",
        parameters: Schema.toStandardSchemaV1(Schema.Struct({ tab_ref: Schema.String })),
        metadata: {
          effect: "none",
          code_mode: true,
          display_name: "Read the page",
          kind: "read",
          action: "read",
          source: "_browser",
          changes_state: false,
          concurrency_group: null,
          destructive: false
        },
        execute: async (_input, ctx) => {
          executed.push(ctx.toolCallId)
          const ref = observations.observe(tab, 3, { "@e1": "Save" }, "https://example.test")
          observations.remember(tab, {
            url: undefined,
            scope: undefined,
            depth: undefined,
            maxChars: 16_000
          })
          const page = { snapshot_ref: ref }
          if (kind === "action-page") host.scriptFields(ctx.toolCallId, () => ({ page }))
          return { result: "Page", preview: "Page", data: kind === "snapshot" ? page : {} }
        }
      })
      let bound: Toolset | undefined
      const host = makeCodeModeHost({
        run,
        tools: [tool],
        scope: new Set(["browser_snapshot"]),
        toolset: () => bound,
        browserObservations: observations
      })
      bound = withMiddleware(createToolset([tool], { toJsonSchema: () => ({}) })(run), [
        localizeOutputs({
          sessionId: "script-session",
          onResult: host.captureResult,
          outputs: { localizeToolResult: async ({ result }) => result }
        })
      ])
      return { host, observations }
    }
    const request = {
      toolCallId: "script:code:page",
      name: "browser_snapshot",
      args: { tab_ref: tab },
      signal: new AbortController().signal,
      detached: false,
      messages: []
    }
    const first = bind()
    const original = await first.host.call(request)
    const recovered = bind()
    expect(recovered.observations.latest(tab)).toBeUndefined()
    expect(await recovered.host.call(request)).toEqual(original)
    expect(executed).toEqual(["script:code:page"])
    expect(claimObservedRevision(recovered.observations, tab, "snap-abcdef", "next-act")).toBe(3)
    expect(() =>
      claimObservedRevision(recovered.observations, tab, "snap-abcdef", "second-act")
    ).toThrow(ToolExecutionError)
  }
)

it.each([
  { continuation: undefined, error: PauseRequested },
  { continuation: "caller" as const, error: ToolExecutionError }
])(
  "only suspends replayable callers at an approval ($continuation)",
  async ({ continuation, error }) => {
    const tool = defineServerTool({
      name: "lookup",
      description: "Read the protected page",
      parameters: Schema.toStandardSchemaV1(Schema.Struct({})),
      metadata: {
        effect: "none",
        code_mode: true,
        display_name: "Lookup",
        kind: "read",
        action: "read",
        source: "_test",
        changes_state: false,
        concurrency_group: null,
        destructive: false
      },
      execute: async () => {
        throw new PauseRequested("approval", "Open the protected page?")
      }
    })
    const run = serverRunContext()
    const toolset = createToolset([tool], { toJsonSchema: () => ({}) })(run)
    const host = makeCodeModeHost({
      run,
      tools: [tool],
      scope: new Set(["lookup"]),
      toolset: () => toolset
    })
    await expect(
      host.call({
        toolCallId: "script:code:lookup",
        name: "lookup",
        args: {},
        signal: new AbortController().signal,
        detached: false,
        messages: [],
        ...(continuation === undefined ? {} : { approvalContinuation: continuation })
      })
    ).rejects.toBeInstanceOf(error)
  }
)

it("splits the display title off a script's call before the durable row and the tool", async () => {
  const durable: Array<ChatRunnerToolRequest["args"]> = []
  const executed: Array<ToolCallRequest["args"]> = []
  const media: unknown[] = []
  const stored: ToolResult[] = []
  const data = { state: { value: "x".repeat(20_000) } }
  let bound: Toolset | undefined
  const tool = defineServerTool({
    name: "automation_list",
    description: "List automations.",
    parameters: Schema.toStandardSchemaV1(Schema.Struct({})),
    metadata: {
      effect: "none",
      code_mode: true,
      display_name: "List automations",
      kind: "read",
      action: "read",
      source: "_automations",
      changes_state: false,
      concurrency_group: null,
      destructive: false
    },
    execute: async () => "[]"
  })
  const toolset: Toolset = {
    displayTitle: TOOL_DISPLAY_TITLE,
    entries: () => [],
    loadedNames: () => new Set(),
    load: () => undefined,
    execute: (request) => {
      executed.push(request.args)
      return {
        content: "[]",
        preview: "None",
        data,
        model_content: [{ type: "image", media_type: "image/png", data: "aW1hZ2U=" }]
      }
    }
  }
  const host = makeCodeModeHost({
    run: serverRunContext({
      executeTool: async (request, operation) => {
        durable.push(request.args)
        const result = await operation()
        stored.push(result)
        return result
      }
    }),
    tools: [tool],
    scope: new Set(["automation_list"]),
    toolset: () => bound
  })
  bound = withMiddleware(toolset, [
    localizeOutputs({
      sessionId: "script-session",
      onResult: host.captureResult,
      outputs: {
        localizeToolResult: async ({ result }) => ({
          ...result,
          data: { managed_output: "private-reference" }
        })
      }
    })
  ])
  const result = await host.call({
    toolCallId: "script-call",
    name: "automation_list",
    args: { [TOOL_DISPLAY_TITLE.argument]: "Listing automations", status: "active" },
    signal: new AbortController().signal,
    detached: false,
    messages: [],
    onResult: (result) => media.push(...(result.model_content ?? []))
  })
  expect(media).toEqual([{ type: "image", media_type: "image/png", data: "aW1hZ2U=" }])
  expect(result).toEqual({ content: "[]", preview: "None", data })
  expect(stored[0]?.data).toEqual({ managed_output: "private-reference" })
  expect({ durable, executed }).toEqual({
    durable: [{ status: "active" }],
    executed: [{ status: "active" }]
  })
})

it("retains inference admission through a running script's later nested calls", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const executed: string[] = []
  let obsolete = false
  const tool = defineServerTool({
    name: "lookup",
    description: "Look up",
    parameters: Schema.toStandardSchemaV1(Schema.Struct({})),
    metadata: {
      effect: "none",
      code_mode: true,
      display_name: "Lookup",
      kind: "read",
      action: "read",
      source: "_test",
      changes_state: false,
      concurrency_group: null,
      destructive: false
    },
    execute: async (_input, ctx) => {
      executed.push(ctx.toolCallId)
      started.resolve()
      await release.promise
      expect(ctx.signal.aborted).toBe(false)
      return "found"
    }
  })
  const run = serverRunContext()
  const nested = createToolset([tool], { toJsonSchema: () => ({}) })(run)
  const host = makeCodeModeHost({
    run,
    tools: [tool],
    scope: new Set(["lookup"]),
    toolset: () => nested
  })
  const script = createTool({
    name: "script",
    description: "Run script",
    metadata: {},
    parameters: Schema.toStandardSchemaV1(Schema.Struct({})),
    execute: async (_input, ctx) => {
      const request = {
        name: "lookup",
        args: {},
        signal: ctx.signal,
        detached: true,
        messages: ctx.messages,
        beforeExecute: ctx.beforeExecute
      }
      await host.call({ ...request, toolCallId: "started" })
      await host.call({ ...request, toolCallId: "obsolete" })
      return "finished"
    }
  })
  const toolset = createToolset([script], { toJsonSchema: () => ({}) })(undefined)
  const running = toolset.execute({
    name: "script",
    args: {},
    toolCallId: "script",
    beforeExecute: async () =>
      obsolete
        ? { content: "New input", preview: "Not started", is_error: true, retryable: true }
        : undefined
  })
  await started.promise
  obsolete = true
  release.resolve()
  await expect(running).rejects.toMatchObject({ retryable: true })
  expect(executed).toEqual(["started"])
})
