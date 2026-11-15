import type { ToolContext } from "@arden-hq/loop"
import { Effect, Layer } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"

import { GlobalInstructions, globalInstructionsLayer } from "../src/context/global-instructions.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import type { ServerTool } from "../src/tools/define.js"
import { directivesTools } from "../src/tools/directives.js"
import type { ServerRunContext } from "../src/tools/run-context.js"
import { withTempDatabase } from "./fixtures/temp-database.js"
import { partialService, recordOf, runAuthority, serverRunContext, sessionHeader } from "./kit.js"

// "Undo my last rule change": list the versions, then restore one, with the owner's approval
// and only in the owner's own turn, the same as any other change to the rules.

const context = (run: ServerRunContext = serverRunContext()): ToolContext<ServerRunContext> => ({
  run,
  signal: new AbortController().signal,
  toolCallId: "call-fixture",
  messages: []
})

const named = (tools: ReadonlyArray<ServerTool>, name: string): ServerTool => {
  const tool = tools.find((candidate) => candidate.definition.name === name)
  if (tool === undefined) throw new Error(`Missing tool ${name}`)
  return tool
}

const textOf = (output: unknown): string => {
  const content = recordOf(output)["content"]
  if (typeof content !== "string") throw new Error("expected a text result")
  return content
}

const withRules = async <A>(
  initial: string,
  use: (
    tools: ReadonlyArray<ServerTool>,
    file: string
  ) => Effect.Effect<A, unknown, GlobalInstructions>
): Promise<A> => {
  const folder = await mkdtemp(join(tmpdir(), "arden-rules-"))
  const file = join(folder, "AGENTS.md")
  await writeFile(file, initial)
  try {
    return await withTempDatabase(
      Effect.gen(function* () {
        const tools = yield* directivesTools.pipe(
          Effect.provideService(
            SessionQueries,
            partialService<SessionQueries["Service"]>("SessionQueries", {
              loadHistoryHeader: () => Effect.succeed(sessionHeader())
            })
          )
        )
        return yield* use(tools, file)
      }).pipe(Effect.provide(Layer.fresh(globalInstructionsLayer(file))))
    )
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

const run = (
  tool: ServerTool,
  input: Readonly<Record<string, unknown>>,
  ctx: ToolContext<ServerRunContext>
) => Effect.promise(() => tool.execute(input, ctx))

it("lists each version with its writer, and restores one in the owner's turn", async () => {
  const { listed, restored, after, diff, relisted } = await withRules("Rule one.\n", (tools, file) =>
    Effect.gen(function* () {
      const ctx = context()
      yield* run(named(tools, "directives_get"), {}, ctx)
      yield* run(named(tools, "directives_set"), { directives: "Rule one.\nRule two." }, ctx)
      const fresh = context()
      const listed = textOf(yield* run(named(tools, "directives_history"), {}, fresh))
      const prompt = yield* Effect.promise(async () =>
        named(tools, "directives_restore").definition.approvalPrompt?.({ version: 1 }, fresh)
      )
      const restored = yield* run(named(tools, "directives_restore"), { version: 1 }, fresh)
      const after = yield* Effect.promise(() => readFile(file, "utf8"))
      const relisted = yield* run(named(tools, "directives_history"), {}, fresh)
      return { listed, restored, after, diff: prompt?.diff ?? "", relisted }
    })
  )
  expect(listed).toContain("version 2 (current)")
  expect(listed).toContain("changed in arden:session/")
  expect(listed).toContain("version 1 ")
  expect(recordOf(restored)["preview"]).toBe("Instructions replaced")
  expect(diff).toContain("-Rule two.")
  expect(after).toBe("Rule one.\n")
  expect(textOf(relisted)).toContain("version 3 (current)")
  expect(textOf(relisted)).toContain("version 1 restored in arden:session/")
  const versions = recordOf(recordOf(relisted)["data"])["versions"]
  if (!Array.isArray(versions)) throw new Error("expected listed versions")
  expect(recordOf(versions[0])).toMatchObject({ version: 3, writer: "restore", restored_from: 1 })
})

it("refuses a restore outside the owner's own turn", async () => {
  await withRules("Rule one.\n", (tools) =>
    Effect.gen(function* () {
      const reviewer = serverRunContext({
        authority: runAuthority({ actor: { kind: "space_review", space_id: "space-1" } })
      })
      const ctx = context(reviewer)
      yield* run(named(tools, "directives_history"), {}, ctx)
      yield* Effect.promise(() =>
        expect(named(tools, "directives_restore").execute({ version: 1 }, ctx)).rejects.toThrow(
          "user's own turn"
        )
      )
    })
  )
})

it("refuses a version the history does not have", async () => {
  await withRules("Rule one.\n", (tools) =>
    Effect.gen(function* () {
      const ctx = context()
      yield* run(named(tools, "directives_history"), {}, ctx)
      yield* Effect.promise(() =>
        expect(named(tools, "directives_restore").execute({ version: 9 }, ctx)).rejects.toThrow(
          "no version 9"
        )
      )
    })
  )
})
