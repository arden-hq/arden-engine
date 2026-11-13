import type { ToolContext } from "@arden-hq/loop"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { SpaceStore } from "../src/persistence/spaces/store.js"
import type { ServerRunContext } from "../src/tools/run-context.js"
import { spaceTools } from "../src/tools/spaces.js"
import { Wiki } from "../src/wiki/service.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { partialService, present, serverRunContext } from "./kit.js"

// space_settings_update replaces a Space's instructions whole, so the model
// must be able to read them first. Only `result` text reaches the model;
// `data` does not, so space_list's text has to carry the instructions.

const context = (): ToolContext<ServerRunContext> => ({
  toolCallId: "call-space-list",
  signal: new AbortController().signal,
  run: serverRunContext({ sessionId: "session-space-list", runId: "run-space-list" }),
  messages: []
})

const listSpaces = (input: { readonly space_id?: string }) =>
  Effect.gen(function* () {
    const tools = yield* spaceTools.pipe(
      Effect.provideService(Wiki, partialService<Wiki["Service"]>("Wiki", {}))
    )
    const list = present(
      tools.find((tool) => tool.definition.name === "space_list"),
      "space_list"
    )
    const output = yield* Effect.promise(() => list.execute(input, context()))
    expect(output.is_error).not.toBe(true)
    return output.content
  })

describe("space_list shows instructions to the model", () => {
  it("prints short instructions whole and caps long ones with a way to read them all", async () => {
    const long = `${"Keep replies short. ".repeat(150)}\nFINAL LINE`
    const { all, one } = await withTempDatabase(
      Effect.gen(function* () {
        const spaces = yield* SpaceStore
        yield* spaces.create({ name: "Home", instructions: "Use metric units.\nNo emoji." })
        yield* spaces.create({ name: "Blank" })
        const big = yield* spaces.create({ name: "Big", instructions: long })
        return {
          all: yield* listSpaces({}),
          one: yield* listSpaces({ space_id: big.space_id })
        }
      })
    )
    expect(all).toContain("  instructions:\n    Use metric units.\n    No emoji.")
    expect(all).toContain("  instructions: none")
    expect(all).toMatch(
      /instructions \(first 2000 of 3011 characters; call space_list with space_id "[^"]+"/
    )
    expect(all).not.toContain("FINAL LINE")
    expect(one).toContain("FINAL LINE")
    expect(one).not.toContain("Home")
  })
})
