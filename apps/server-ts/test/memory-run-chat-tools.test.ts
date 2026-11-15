import type { ToolEntry, Toolset } from "@arden-hq/loop"
import { expect, it } from "vitest"
import { memoryCaptureHandler } from "../src/automations/handlers/memory-capture.js"
import { wikiMaintenanceHandler } from "../src/automations/handlers/wiki-maintenance.js"

const NAMES = ["wiki_read_page", "session_read", "session_search_transcripts", "wiki_merge_page"]
const base = (): Toolset => ({
  entries: () =>
    NAMES.map((name): ToolEntry => ({ description: name, parameters: {}, meta: { name } })),
  loadedNames: () => new Set(NAMES),
  load: () => undefined,
  execute: () => ({ content: "ran", preview: "ran" })
})
const advertised = async (toolset: Toolset) =>
  (await toolset.entries()).map((item) => item.meta.name)

it("Memory Capture cannot read other chats or merge pages, but Tidy can", async () => {
  expect(await advertised(memoryCaptureHandler.tools?.(base()) ?? base())).toEqual([
    "wiki_read_page"
  ])
  expect(await advertised(wikiMaintenanceHandler.tools?.(base()) ?? base())).toEqual(NAMES)
})
