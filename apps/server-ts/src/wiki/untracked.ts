import type { UntrackedFile, WorkingTreeStatusOptions } from "@arden-hq/revisions/effect"
import { Effect, Option } from "effect"

import { parseWikiPage } from "./page.js"

const isPagePath = (path: string): boolean => path.endsWith(".md")

export const UNTRACKED_PAGES: WorkingTreeStatusOptions = { readUntracked: isPagePath }

const decoder = new TextDecoder("utf-8", { fatal: true })

export const utf8 = (bytes: Uint8Array): string | undefined => {
  try {
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}

export interface UntrackedFiles {
  readonly notInMemory: ReadonlyArray<string>
  readonly otherFiles: ReadonlyArray<string>
  readonly unreadableFiles: ReadonlyArray<{ readonly path: string; readonly reason: string }>
}

export const untrackedFiles = (files: ReadonlyArray<UntrackedFile>): UntrackedFiles => {
  const readable = files.filter((file) => file.kind !== "unreadable").map((file) => file.path)
  return {
    notInMemory: readable.filter(isPagePath),
    otherFiles: readable.filter((path) => !isPagePath(path)),
    unreadableFiles: files.flatMap((file) =>
      file.kind === "unreadable" ? [{ path: file.path, reason: file.reason }] : []
    )
  }
}

export const untrackedPageIds = Effect.fn("Wiki.untrackedPageIds")(function* (
  files: ReadonlyArray<UntrackedFile>
) {
  const ids: Array<{ readonly path: string; readonly pageId: string }> = []
  for (const file of files) {
    if (file.kind !== "read") continue
    const text = utf8(file.content)
    if (text === undefined) continue
    const parsed = yield* Effect.option(parseWikiPage(text))
    if (Option.isSome(parsed)) ids.push({ path: file.path, pageId: parsed.value.pageId })
  }
  return ids
})
