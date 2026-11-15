import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "../src")
const OWNER = "sessions/chat-href.ts"
const LINKER = "tools/call-receipt.ts"

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

it("builds and reads chat links only in the owner", () => {
  const building = files
    .filter(
      ({ path, text }) =>
        path !== OWNER && /arden:session\/\$\{|["'`]arden:session\/["'`]/u.test(text)
    )
    .map(({ path }) => path)
  expect(building).toEqual([])
})

const LINKS_NOT_FROM_HEADERS = {
  "tools/workflows.ts": "loads headers to check access; links a script's stored chat ref"
}

it("turns a chat id into a link only through chatLinkOf", () => {
  const looking = files
    .filter(
      ({ path, text }) =>
        path !== LINKER &&
        !(path in LINKS_NOT_FROM_HEADERS) &&
        text.includes("loadHistoryHeader") &&
        text.includes("chatHref(")
    )
    .map(({ path }) => path)
  expect(looking).toEqual([])
})
