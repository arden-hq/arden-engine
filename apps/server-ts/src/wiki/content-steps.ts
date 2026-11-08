import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { sha256Hex } from "@arden-hq/std/hash"
import { Effect } from "effect"

import { commitWiki, createPage, updatePage, type WikiPageOperation } from "./commit.js"
import { mapRevisionError, type WikiError, wikiError } from "./errors.js"
import { isImportedPath } from "./imported.js"
import { formatRedirectPage, normal, pageNamesForPath, reviseWikiPage } from "./page.js"
import { loadSnapshot } from "./snapshot.js"

interface ContentStepPage {
  readonly path: string
  readonly title: string
  readonly aliases: ReadonlyArray<string>
  readonly body: string
}

export interface ContentStepRedirect {
  readonly path: string
  readonly to: number
}

export interface ContentStepRewrite {
  readonly pages: ReadonlyArray<ContentStepPage>
  readonly redirects: ReadonlyArray<ContentStepRedirect>
}

export interface WikiContentStep<E> {
  readonly name: string
  readonly reason: string
  readonly rewrite: (
    pages: ReadonlyArray<ContentStepPage>,
    taken: ReadonlySet<string>
  ) => Effect.Effect<ContentStepRewrite, E>
}

type WikiContentStepResult =
  | { readonly kind: "already_applied" }
  | { readonly kind: "applied"; readonly changedPaths: ReadonlyArray<string> }

export interface WikiContentStepMethods {
  readonly applyContentStep: <E>(
    step: WikiContentStep<E>
  ) => Effect.Effect<WikiContentStepResult, WikiError | E>
}

const ORIGIN_PREFIX = "memory.content-step."

export const isContentStepOrigin = (origin: string): boolean => origin.startsWith(ORIGIN_PREFIX)

const receiptKey = (name: string): string => `memory-content-step:${name}`

const redirectId = (path: string): string => `wiki-redirect:path:${sha256Hex(normal(path))}`

export const makeWikiContentStepMethods = (
  repository: ManagedFileRepositoryShape
): WikiContentStepMethods => ({
  applyContentStep: Effect.fn("Wiki.applyContentStep")(function* <E>(
    step: WikiContentStep<E>
  ): Effect.fn.Return<WikiContentStepResult, WikiError | E> {
    const key = receiptKey(step.name)
    const receipt = yield* repository
      .idempotencyReceipt(key)
      .pipe(Effect.mapError(mapRevisionError("read")))
    if (receipt !== null) return { kind: "already_applied" } as const
    const snapshot = yield* loadSnapshot(repository, "update")
    const pages = snapshot.pages.filter(
      ({ page, resource }) =>
        page.lifecycle === "active" &&
        !isImportedPath(resource.path) &&
        resource.path.toLowerCase() !== "health.md"
    )
    const taken = new Set(
      snapshot.pages.flatMap((record) => pageNamesForPath(record.resource.path).map(normal))
    )
    const rewritten = yield* step.rewrite(
      pages.map(({ page, resource }) => ({
        path: resource.path,
        title: page.title,
        aliases: page.aliases,
        body: page.body
      })),
      taken
    )
    const changed: Array<string> = []
    const operations: Array<WikiPageOperation> = []
    for (const [index, record] of pages.entries()) {
      const next = rewritten.pages[index]
      if (next === undefined) continue
      const content = yield* reviseWikiPage(record.page, {
        body: next.body,
        aliases: next.aliases
      }).pipe(
        Effect.mapError((cause) =>
          wikiError("update", "invalid", cause.message, { pageId: record.page.pageId, cause })
        )
      )
      if (content === record.page.content) continue
      changed.push(record.resource.path)
      operations.push(updatePage(record.resource, content))
    }
    const redirects = rewritten.redirects.flatMap(({ path, to }) => {
      const target = pages[to]
      return target === undefined ? [] : [{ path, target }]
    })
    for (const { path, target } of redirects) {
      const pageId = redirectId(path)
      operations.push(
        createPage(
          pageId,
          path,
          formatRedirectPage({ pageId, title: target.page.title, redirectTo: target.page.pageId })
        )
      )
    }
    if (operations.length > 0) {
      yield* commitWiki(
        repository,
        {
          actor: "system",
          origin: { kind: "system", name: `${ORIGIN_PREFIX}${step.name}` },
          reason: step.reason,
          expectedRevision: snapshot.head
        },
        operations
      ).pipe(Effect.mapError(mapRevisionError("update")))
    }
    if (snapshot.head !== null) {
      yield* repository
        .finalizeIdempotencyReceipt(key, key)
        .pipe(Effect.mapError(mapRevisionError("update")))
    }
    return {
      kind: "applied",
      changedPaths: [...changed, ...redirects.map(({ path }) => path)]
    } as const
  })
})
