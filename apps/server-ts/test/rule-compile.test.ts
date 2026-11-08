import { homedir } from "node:os"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { PermissionRulesError } from "../src/persistence/permissions/rules.js"
import { checkCompiled } from "../src/tools/rule-compile.js"

it("drops a compiled rule Settings would refuse, and names it", async () => {
  const subjects = (subject: {
    readonly kind: string
    readonly tool?: string
    readonly path?: string
    readonly access?: string
  }) => {
    if (subject.kind === "path") return Effect.succeed([subject])
    if (subject.tool === "made_up")
      return Effect.fail(
        new PermissionRulesError({
          operation: "save",
          reason: "invalid",
          message: "Unknown tool: made_up"
        })
      )
    return Effect.succeed([{ kind: "tool" as const, tool: subject.tool ?? "", server: null }])
  }
  const { kept, dropped } = await Effect.runPromise(
    checkCompiled(
      [
        { decision: "allow", wire: { kind: "tool", tool: "email_send" } },
        { decision: "allow", wire: { kind: "tool", tool: "made_up" } },
        { decision: "ask", wire: { kind: "path", path: "/Users/me/src", access: "change" } },
        { decision: "never", wire: "a folder rule named no folder" },
        { decision: "never", wire: { kind: "path", path: "/", access: "read" } },
        { decision: "never", wire: { kind: "path", path: homedir(), access: "read" } }
      ],
      subjects as never
    )
  )
  expect(kept.map((rule) => rule.wire)).toEqual([{ kind: "tool", tool: "email_send" }])
  expect(dropped).toEqual([
    "Unknown tool: made_up",
    "a folder rule allows or never: /Users/me/src",
    "a folder rule named no folder",
    "a folder rule too wide for words: /",
    `a folder rule too wide for words: ${homedir()}`
  ])
})
