import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { expect, it } from "vitest"

// A chat link is built in one place, `chatHref` in tools/call-receipt.ts, and a chat named by its
// id becomes a link only through `chatLinkOf` there. The files below built links before that
// owner existed; they may move to it, and no file may join them.

const ROOT = join(import.meta.dirname, "../src")
const OWNER = "tools/call-receipt.ts"

const OLDER_BUILDERS = [
  "automations/handlers/daily-summary.ts",
  "automations/home-letter-links.ts",
  "automations/space-review-input.ts",
  "context/space-render.ts",
  "context/system-context.ts",
  "context/thread.ts",
  "memory/chat-citations.ts",
  "memory/retrieval.ts",
  "persistence/sqlite/chat-agent-spawn.ts",
  "prompts/task-state.ts",
  "tools/agent-message.ts",
  "tools/onboarding.ts"
]

const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith(".ts") ? [path] : []
  })

const files = sources(ROOT).map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, "utf8")
}))

it("builds chat links only in the owner and in files that did so before it", () => {
  const building = files
    .filter(({ path, text }) => path !== OWNER && text.includes("arden:session/${"))
    .map(({ path }) => path)
  expect(building.filter((path) => !OLDER_BUILDERS.includes(path))).toEqual([])
})

it("turns a chat id into a link only through the owner", () => {
  const looking = files
    .filter(
      ({ path, text }) =>
        path !== OWNER && text.includes("loadHistoryHeader") && text.includes("arden:session/")
    )
    .map(({ path }) => path)
  expect(looking).toEqual([])
})
