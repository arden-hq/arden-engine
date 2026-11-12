import type { ToolCallRequest, ToolEntry, Toolset } from "@arden-hq/loop"
import { describe, expect, it } from "vitest"

import { memoryCaptureHandler } from "../src/automations/handlers/memory-capture.js"
import { wikiMaintenanceHandler } from "../src/automations/handlers/wiki-maintenance.js"
import { withoutTools } from "../src/execution/toolset-middleware.js"

const NAMES = ["wiki_read_page", "session_read", "session_search_transcripts"]

const entry = (name: string): ToolEntry => ({
  description: name,
  parameters: {},
  meta: { name }
})

const base = (): Toolset => ({
  entries: () => NAMES.map(entry),
  loadedNames: () => new Set(NAMES),
  load: () => undefined,
  execute: (request) => ({ content: `ran ${request.name}`, preview: "ran" })
})

const call = (name: string) => ({ name }) as unknown as ToolCallRequest

const advertised = async (toolset: Toolset) =>
  (await toolset.entries()).map((item) => item.meta.name)

describe("chat-read tools in Memory runs", () => {
  it("hides a named tool from the catalog, the loaded set and execution", async () => {
    const toolset = withoutTools(base(), new Set(["session_read"]))
    expect(await advertised(toolset)).toEqual(["wiki_read_page", "session_search_transcripts"])
    expect([...(await toolset.loadedNames())]).not.toContain("session_read")
    expect(await toolset.execute(call("session_read"))).toMatchObject({ is_error: true })
    expect(await toolset.execute(call("wiki_read_page"))).toMatchObject({
      content: "ran wiki_read_page"
    })
  })

  it("Memory Capture cannot read other chats; it judges the batch it was handed", async () => {
    const toolset = memoryCaptureHandler.tools?.(base()) ?? base()
    expect(await advertised(toolset)).toEqual(["wiki_read_page"])
  })

  it("Wiki Maintenance keeps the chat-read tools to check notes against their chats", async () => {
    const toolset = wikiMaintenanceHandler.tools?.(base()) ?? base()
    expect(await advertised(toolset)).toEqual(NAMES)
  })
})
