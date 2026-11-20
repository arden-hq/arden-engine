import type { ManagedFileRepositoryOptions } from "@arden-hq/revisions/effect"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { readdir } from "node:fs/promises"
import { resolve } from "node:path"

import { PROMPTS } from "../prompts/catalog.js"

import { GLOBAL_WIKI_LOCATION_AUTHORITY } from "./authority.js"
import { RULES_PAGE_PATH, RULES_PAGE_TITLE } from "./code-owned-pages.js"
import { commitWiki, createPage, type WikiCommitPoint } from "./commit.js"
import { mapRevisionError, wikiError, type WikiError } from "./errors.js"
import { formatWikiPage } from "./page.js"

export const initializeWikiFoundation = Effect.fn("Wiki.initializeFoundation")(function* (
  { repository, spaces }: WikiCommitPoint,
  options: Pick<ManagedFileRepositoryOptions, "workingRoot" | "historyRoot">
): Effect.fn.Return<void, WikiError> {
  const head = yield* repository.currentRevision.pipe(Effect.mapError(mapRevisionError("open")))
  if (head !== null) return
  const entries = yield* Effect.tryPromise({
    try: () => readdir(options.workingRoot),
    catch: (cause) =>
      wikiError("open", "storage", "Could not read the Memory working folder", { cause })
  })
  const historyRoot = resolve(
    options.historyRoot ?? resolve(options.workingRoot, ".managed-history")
  )
  if (entries.some((entry) => resolve(options.workingRoot, entry) !== historyRoot)) return

  const pages = [
    {
      path: "README.md",
      title: "Memory",
      body: `# Memory

Personal knowledge: context, facts and decisions. Executable work lives in Tasks.
Create me.md when confirmed profile facts or cross-context preferences are available.

## Filing

${PROMPTS.memoryFilingRule}

Each directory README describes its purpose, producers, consumers, boundaries and retention.
For dated collections, add a Records section: filename convention, timezone, original source links
and how readers find records. The collection catalog derives from these contracts.
Keep indexes as navigation. Preserve dated evidence and link it from current claims;
editing a page does not make its facts newly verified. Distinguish separate cycles and subjects.
Keep unresolved conflicts explicit. Preserve page identity and history when reorganizing.

Filing rules do not grant permission to act. Application configuration, execution logs and
checkpoints stay in application storage. Add specialist directories only when a workflow needs them.
`
    }
  ]
  yield* commitWiki(
    { repository, spaces },
    {
      actor: "system",
      origin: { kind: "system", name: "wiki.foundation" },
      authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
      reason: "Initialize personal Memory",
      expectedRevision: null
    },
    pages.map((page) => {
      const pageId = randomUUID()
      return createPage(
        pageId,
        page.path,
        formatWikiPage({
          pageId,
          title: page.title,
          aliases: [],
          lifecycle: "active",
          redirectTo: null,
          metadata: {},
          body: page.body
        })
      )
    })
  ).pipe(Effect.mapError(mapRevisionError("open")))
})

/** Makes the owner's rules page from `body`, the rules file it replaces, as the owner's own words. */
export const createRulesPage = Effect.fn("Wiki.createRulesPage")(function* (
  { repository, spaces }: WikiCommitPoint,
  body: string
): Effect.fn.Return<void, WikiError> {
  const pageId = randomUUID()
  const head = yield* repository.currentRevision.pipe(Effect.mapError(mapRevisionError("create")))
  yield* commitWiki(
    { repository, spaces },
    {
      actor: "user:external",
      origin: { kind: "user", via: "filesystem" },
      authority: GLOBAL_WIKI_LOCATION_AUTHORITY,
      reason: `move the standing rules into Memory as ${RULES_PAGE_PATH}`,
      expectedRevision: head
    },
    [
      createPage(
        pageId,
        RULES_PAGE_PATH,
        formatWikiPage({
          pageId,
          title: RULES_PAGE_TITLE,
          aliases: [],
          lifecycle: "active",
          redirectTo: null,
          metadata: {},
          body
        })
      )
    ]
  ).pipe(Effect.mapError(mapRevisionError("create", pageId)))
})
