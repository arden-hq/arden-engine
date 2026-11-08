import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, it } from "vitest"
import { ripgrepFind, ripgrepSearchFiles } from "../src/tools/ripgrep.js"

it("a search skips the folders a never rule hides, in any case and with glob characters in the name", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "arden-rg-never-")))
  try {
    await mkdir(path.join(root, "private [x]"), { recursive: true })
    await mkdir(path.join(root, "open"))
    await writeFile(path.join(root, "private [x]", "secret.txt"), "needle\n")
    await writeFile(path.join(root, "open", "note.txt"), "needle\n")
    const signal = new AbortController().signal
    const found = await ripgrepFind({
      cwd: root,
      pattern: "*",
      includeHidden: true,
      limit: 50,
      signal,
      skip: ["PRIVATE [x]"]
    })
    expect(found.items).toEqual(["open/note.txt"])
    const searched = await ripgrepSearchFiles({
      cwd: root,
      query: "needle",
      target: ".",
      includeHidden: true,
      limit: 50,
      signal,
      skip: ["private [x]"]
    })
    expect(searched.items).toEqual(["open/note.txt"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
