import type { ManagedFileRepositoryShape, ResourceVersion } from "@arden-hq/revisions/effect"
import {
  commitWiki,
  createPage,
  isAutomatedOrigin,
  movePage,
  updatePage,
  type WikiCommitIdentity
} from "./commit.js"
import type { WikiRenameApproval } from "@arden-hq/protocol/wiki"
import { Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { posix } from "node:path"

import type { SpaceStore } from "../persistence/spaces/store.js"
import {
  WikiRenameStoreError,
  type WikiRenameApprovalRecord,
  type WikiRenameStore
} from "../persistence/wiki/rename-store.js"
import {
  requireWikiWritePaths,
  resolveWikiWriteBoundary,
  type WikiLocationAuthority
} from "./authority.js"
import { mapRevisionError, WikiError, wikiError } from "./errors.js"
import { pageWikiLinks, rewriteWikiLinkTargets } from "./links.js"
import { formatRedirectPage, pageNamesForPath, parseWikiPage, reviseWikiPage } from "./page.js"
import { loadSnapshot, pageNameIndex, resolveWikiLinkTarget, type PageRecord } from "./snapshot.js"

const ResourceSchema = Schema.Struct({
  resourceId: Schema.NonEmptyString,
  versionId: Schema.NonEmptyString
})

const RewriteSchema = Schema.Struct({
  resource: ResourceSchema,
  content: Schema.String
})

const RenamePlanSchema = Schema.Struct({
  baseHead: Schema.NonEmptyString,
  pageId: Schema.NonEmptyString,
  oldPath: Schema.NonEmptyString,
  newPath: Schema.NonEmptyString,
  oldTitle: Schema.NonEmptyString,
  newTitle: Schema.NonEmptyString,
  source: ResourceSchema,
  movedContent: Schema.String,
  redirect: Schema.Struct({
    resourceId: Schema.NonEmptyString,
    path: Schema.NonEmptyString,
    content: Schema.String
  }),
  rewrites: Schema.Array(RewriteSchema),
  linkCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

type RenamePlan = typeof RenamePlanSchema.Type
type PlannedResource = RenamePlan["source"]

interface WikiRenameRequestInput {
  readonly pageId: string
  readonly newPath: string
  readonly newTitle: string
  readonly expectedVersion: string
  readonly expectedHead: string
  readonly authority: WikiLocationAuthority
}

interface WikiRenameAcceptInput {
  readonly approvalId: string
  readonly authority: WikiLocationAuthority
  readonly commit?: WikiCommitIdentity
}

export interface WikiRenameMethods {
  readonly listRenameApprovals: () => Effect.Effect<ReadonlyArray<WikiRenameApproval>, WikiError>
  readonly requestRename: (
    input: WikiRenameRequestInput
  ) => Effect.Effect<WikiRenameApproval, WikiError>
  readonly acceptRename: (
    input: WikiRenameAcceptInput
  ) => Effect.Effect<WikiRenameApproval, WikiError>
  readonly rejectRename: (
    approvalId: string,
    resolution?: string | null
  ) => Effect.Effect<WikiRenameApproval, WikiError>
}

const storeErrorReason = (reason: WikiRenameStoreError["reason"]) => {
  switch (reason) {
    case "conflict":
      return "blocked" as const
    case "not_found":
    case "corrupt":
    case "invalid":
    case "storage":
      return reason
  }
}

const mapStoreError = (cause: WikiRenameStoreError): WikiError => {
  const reason = storeErrorReason(cause.reason)
  return wikiError("rename", reason, cause.message, {
    ...(cause.pageId === undefined ? {} : { pageId: cause.pageId }),
    cause
  })
}

const decodePlan = Effect.fn("WikiRename.decodePlan")(function* (
  approval: WikiRenameApprovalRecord
): Effect.fn.Return<RenamePlan, WikiError> {
  const plan = yield* Schema.decodeUnknownEffect(RenamePlanSchema)(approval.plan, {
    onExcessProperty: "error"
  }).pipe(
    Effect.mapError((cause) =>
      wikiError("rename", "corrupt", "Stored Wiki rename plan is invalid", {
        pageId: approval.pageId,
        cause
      })
    )
  )
  if (plan.pageId !== approval.pageId) {
    return yield* wikiError(
      "rename",
      "corrupt",
      "Stored Wiki rename page identity does not match",
      {
        pageId: approval.pageId
      }
    )
  }
  return plan
})

const approvalView = Effect.fn("WikiRename.approvalView")(function* (
  approval: WikiRenameApprovalRecord
): Effect.fn.Return<WikiRenameApproval, WikiError> {
  const plan = yield* decodePlan(approval)
  return {
    approvalId: approval.approvalId,
    oldPath: plan.oldPath,
    newPath: plan.newPath,
    oldTitle: plan.oldTitle,
    newTitle: plan.newTitle,
    linkCount: plan.linkCount,
    pageCount: plan.pageCount,
    status: approval.status,
    createdAt: approval.createdAt,
    resolution: approval.resolution
  }
})

const linkTarget = (path: string, keepExtension: boolean): string => {
  if (keepExtension) return path
  if (posix.basename(path).toLowerCase() === "readme.md") {
    const directory = posix.dirname(path)
    return directory === "." ? posix.basename(path, ".md") : directory
  }
  return path.endsWith(".md") ? path.slice(0, -3) : path
}

const plannedResource = (resource: ResourceVersion): PlannedResource => ({
  resourceId: resource.resourceId,
  versionId: resource.versionId
})

const buildPlan = Effect.fn("WikiRename.buildPlan")(function* (
  repository: ManagedFileRepositoryShape,
  source: PageRecord,
  pages: ReadonlyArray<PageRecord>,
  head: string,
  newPath: string,
  newTitle: string
): Effect.fn.Return<RenamePlan, WikiError> {
  const byId = new Map(pages.map((record) => [record.page.pageId, record] as const))
  const names = pageNameIndex(pages)
  const rewrites: Array<{ resource: PlannedResource; content: string }> = []
  let movedBody = source.page.body
  let linkCount = 0
  let pageCount = 0

  for (const record of pages) {
    if (record.page.lifecycle !== "active") continue
    const replacements = new Map()
    for (const token of pageWikiLinks(record.page)) {
      if (
        token.page !== null &&
        resolveWikiLinkTarget(byId, names, record.page.pageId, token) === source.page.pageId
      ) {
        replacements.set(token, linkTarget(newPath, token.page.toLowerCase().endsWith(".md")))
      }
    }
    if (replacements.size === 0) continue
    const body = yield* Effect.try({
      try: () => rewriteWikiLinkTargets(record.page.body, replacements),
      catch: (cause) =>
        wikiError("rename", "invalid", "Could not rewrite Wiki links", {
          pageId: record.page.pageId,
          cause
        })
    })
    linkCount += replacements.size
    pageCount += 1
    if (record.page.pageId === source.page.pageId) {
      movedBody = body
    } else {
      rewrites.push({
        resource: plannedResource(record.resource),
        content: yield* reviseWikiPage(record.page, { body }).pipe(
          Effect.mapError((cause) =>
            wikiError("rename", "invalid", "Could not preserve Wiki page content", {
              pageId: record.page.pageId,
              cause
            })
          )
        )
      })
    }
  }

  const redirectId = `wiki-redirect:${source.resource.versionId}`
  const resources = yield* repository
    .listResources({
      at: head,
      includeArchived: true
    })
    .pipe(Effect.mapError(mapRevisionError("rename", source.page.pageId)))
  if (
    resources.some((resource) => resource.resourceId.toLowerCase() === redirectId.toLowerCase())
  ) {
    return yield* wikiError("rename", "blocked", "A redirect already owns the previous Wiki path", {
      pageId: source.page.pageId
    })
  }

  const movedContent = yield* reviseWikiPage(source.page, {
    title: newTitle,
    body: movedBody
  }).pipe(
    Effect.mapError((cause) =>
      wikiError("rename", "invalid", "Could not preserve the renamed Wiki page", {
        pageId: source.page.pageId,
        cause
      })
    )
  )
  const redirectContent = formatRedirectPage({
    pageId: redirectId,
    title: source.page.title,
    redirectTo: source.page.pageId
  })
  yield* Effect.forEach(
    [
      [source.page.pageId, movedContent],
      [redirectId, redirectContent],
      ...rewrites.map(({ resource, content }) => [resource.resourceId, content] as const)
    ] as const,
    ([pageId, content]) =>
      parseWikiPage(content, pageId).pipe(
        Effect.mapError((cause) =>
          wikiError("rename", "invalid", "The Wiki rename would create an invalid page", {
            pageId,
            cause
          })
        )
      ),
    { discard: true }
  )

  return {
    baseHead: head,
    pageId: source.page.pageId,
    oldPath: source.resource.path,
    newPath,
    oldTitle: source.page.title,
    newTitle,
    source: plannedResource(source.resource),
    movedContent,
    redirect: {
      resourceId: redirectId,
      path: source.resource.path,
      content: redirectContent
    },
    rewrites,
    linkCount,
    pageCount
  }
})

const loadApproval = Effect.fn("WikiRename.loadApproval")(function* (
  store: WikiRenameStore["Service"],
  approvalId: string
): Effect.fn.Return<WikiRenameApprovalRecord, WikiError> {
  const approval = yield* store.get(approvalId).pipe(Effect.mapError(mapStoreError))
  return approval === null
    ? yield* wikiError("rename", "not_found", "Wiki rename approval was not found")
    : approval
})

const planAlreadyApplied = Effect.fn("WikiRename.planAlreadyApplied")(function* (
  repository: ManagedFileRepositoryShape,
  plan: RenamePlan
) {
  const snapshot = yield* loadSnapshot(repository, "rename")
  const pages = new Map(snapshot.pages.map((record) => [record.page.pageId, record] as const))
  const source = pages.get(plan.pageId)
  const redirect = pages.get(plan.redirect.resourceId)
  if (
    source?.resource.path !== plan.newPath ||
    source.page.content !== plan.movedContent ||
    redirect?.resource.path !== plan.redirect.path ||
    redirect.page.content !== plan.redirect.content
  ) {
    return false
  }
  return plan.rewrites.every(
    ({ resource, content }) => pages.get(resource.resourceId)?.page.content === content
  )
})

const planMutationPaths = Effect.fn("WikiRename.planMutationPaths")(function* (
  plan: RenamePlan,
  pages: ReadonlyArray<PageRecord>
): Effect.fn.Return<ReadonlyArray<string>, WikiError> {
  const byId = new Map(pages.map((record) => [record.page.pageId, record] as const))
  const paths = [plan.oldPath, plan.newPath, plan.redirect.path]
  for (const rewrite of plan.rewrites) {
    const record = byId.get(rewrite.resource.resourceId)
    if (record === undefined) {
      return yield* wikiError("rename", "conflict", "A Wiki rename backlink page changed", {
        pageId: rewrite.resource.resourceId
      })
    }
    paths.push(record.resource.path)
  }
  return paths
})

const reportDestination = (
  pages: ReadonlyArray<PageRecord>,
  path: string
): PageRecord | undefined =>
  pages.find(
    (record) =>
      record.page.lifecycle === "active" &&
      Object.hasOwn(record.page.metadata, "producer_automation_id") &&
      posix.basename(record.resource.path).toLowerCase() === "readme.md" &&
      path.toLowerCase().startsWith(`${posix.dirname(record.resource.path).toLowerCase()}/`)
  )

export const makeWikiRenameMethods = (
  repository: ManagedFileRepositoryShape,
  spaces: SpaceStore["Service"],
  store: WikiRenameStore["Service"]
): WikiRenameMethods => {
  const listRenameApprovals = Effect.fn("WikiRename.list")(function* () {
    const approvals = yield* store.listOpen().pipe(Effect.mapError(mapStoreError))
    return yield* Effect.forEach(approvals, approvalView)
  })

  const requestRename = Effect.fn("WikiRename.request")(function* (input: WikiRenameRequestInput) {
    const snapshot = yield* loadSnapshot(repository, "rename")
    const current = snapshot.pages.find((record) => record.page.pageId === input.pageId)
    if (current === undefined) {
      return yield* wikiError("rename", "not_found", `Unknown Wiki page: ${input.pageId}`, {
        pageId: input.pageId
      })
    }
    if (
      snapshot.head !== input.expectedHead ||
      current.resource.versionId !== input.expectedVersion
    ) {
      return yield* wikiError("rename", "conflict", "Wiki page changed", {
        pageId: input.pageId,
        currentContent: current.page.content,
        currentVersion: current.resource.versionId,
        currentHead: snapshot.head
      })
    }
    if (current.page.lifecycle !== "active") {
      return yield* wikiError("rename", "invalid", "Only active Wiki pages can be renamed", {
        pageId: input.pageId
      })
    }
    if (input.newPath.toLowerCase() === current.resource.path.toLowerCase()) {
      return yield* wikiError("rename", "invalid", "A Wiki rename requires a different path", {
        pageId: input.pageId
      })
    }
    if (reportDestination(snapshot.pages, input.newPath) !== undefined) {
      return yield* wikiError(
        "rename",
        "blocked",
        "Publish reports through their producer instead of moving pages into its directory",
        {
          pageId: input.pageId
        }
      )
    }
    const targetNames = new Set(
      pageNamesForPath(input.newPath).map((name) => name.trim().toLowerCase())
    )
    if (
      pageNamesForPath(current.resource.path).some((name) =>
        targetNames.has(name.trim().toLowerCase())
      )
    ) {
      return yield* wikiError(
        "rename",
        "blocked",
        "The new Wiki path conflicts with the redirect kept at the old path",
        {
          pageId: input.pageId
        }
      )
    }
    const nameOwner = snapshot.pages.find(
      (record) =>
        record.page.pageId !== input.pageId &&
        pageNamesForPath(record.resource.path).some((name) =>
          targetNames.has(name.trim().toLowerCase())
        )
    )
    if (nameOwner !== undefined) {
      return yield* wikiError(
        "rename",
        "blocked",
        "Another Wiki page already owns the new path or link name",
        {
          pageId: input.pageId
        }
      )
    }
    if (posix.basename(current.resource.path).toLowerCase() === "readme.md") {
      const prefix = `${posix.dirname(current.resource.path)}/`
      if (
        snapshot.pages.some(
          (record) =>
            record.page.pageId !== input.pageId &&
            record.page.lifecycle === "active" &&
            record.resource.path.startsWith(prefix)
        )
      ) {
        return yield* wikiError(
          "rename",
          "blocked",
          "Move child pages before renaming this directory page",
          {
            pageId: input.pageId
          }
        )
      }
    }
    const spaceBound = yield* spaces.hasPageBinding(input.pageId, current.resource.path).pipe(
      Effect.mapError((cause) =>
        wikiError("rename", "storage", "Could not check Space page ownership", {
          pageId: input.pageId,
          cause
        })
      )
    )
    if (spaceBound) {
      return yield* wikiError(
        "rename",
        "blocked",
        "A Space owns this Wiki page; move or archive the Space first",
        {
          pageId: input.pageId
        }
      )
    }
    if (snapshot.head === null) {
      return yield* wikiError("rename", "corrupt", "A stored Wiki page has no repository head", {
        pageId: input.pageId
      })
    }

    const plan = yield* buildPlan(
      repository,
      current,
      snapshot.pages,
      snapshot.head,
      input.newPath,
      input.newTitle
    )
    const boundary = yield* resolveWikiWriteBoundary(spaces, input.authority, snapshot, "rename")
    const paths = yield* planMutationPaths(plan, snapshot.pages)
    yield* requireWikiWritePaths(boundary, "rename", paths)
    const approval = yield* store
      .createOrGet({
        approvalId: randomUUID(),
        pageId: input.pageId,
        plan
      })
      .pipe(Effect.mapError(mapStoreError))
    return yield* approvalView(approval)
  })

  const acceptRename = Effect.fn("WikiRename.accept")(function* (input: WikiRenameAcceptInput) {
    let approval = yield* loadApproval(store, input.approvalId)
    let plan = yield* decodePlan(approval)
    if (approval.status === "accepted" || approval.status === "rejected") {
      return yield* approvalView(approval)
    }
    const alreadyApplied =
      approval.status === "applying" ? yield* planAlreadyApplied(repository, plan) : false
    if (approval.status === "pending" || !alreadyApplied) {
      const snapshot = yield* loadSnapshot(repository, "rename")
      const boundary = yield* resolveWikiWriteBoundary(spaces, input.authority, snapshot, "rename")
      const paths = yield* planMutationPaths(plan, snapshot.pages)
      yield* requireWikiWritePaths(boundary, "rename", paths)
      if (reportDestination(snapshot.pages, plan.newPath) !== undefined) {
        return yield* wikiError(
          "rename",
          "blocked",
          "Publish reports through their producer instead of moving pages into its directory",
          {
            pageId: plan.pageId
          }
        )
      }
      if (input.commit !== undefined && isAutomatedOrigin(input.commit.origin)) {
        const rewrites = new Set(plan.rewrites.map((rewrite) => rewrite.resource.resourceId))
        const protectedPage = snapshot.pages.find(
          (record) =>
            Object.hasOwn(record.page.metadata, "producer_automation_id") &&
            (record.page.pageId === plan.pageId || rewrites.has(record.page.pageId))
        )
        if (protectedPage !== undefined) {
          return yield* wikiError(
            "rename",
            "blocked",
            "Automation runs cannot move produced pages or rewrite producer-owned reports",
            {
              pageId: protectedPage.page.pageId
            }
          )
        }
      }
      const spaceBound = yield* spaces.hasPageBinding(plan.pageId, plan.oldPath).pipe(
        Effect.mapError((cause) =>
          wikiError("rename", "storage", "Could not check Space page ownership", {
            pageId: plan.pageId,
            cause
          })
        )
      )
      if (spaceBound) {
        if (approval.status === "applying") {
          yield* store
            .releaseApply(
              approval.approvalId,
              "A Space took ownership before the rename was committed"
            )
            .pipe(Effect.mapError(mapStoreError))
        }
        return yield* wikiError(
          "rename",
          "blocked",
          "A Space owns this Wiki page; move or archive the Space first",
          {
            pageId: plan.pageId
          }
        )
      }
    }
    if (approval.status === "pending") {
      approval = yield* store.beginApply(input.approvalId).pipe(Effect.mapError(mapStoreError))
      plan = yield* decodePlan(approval)
      if (approval.status === "accepted" || approval.status === "rejected") {
        return yield* approvalView(approval)
      }
    }

    const outcome = yield* commitWiki(
      repository,
      {
        idempotencyKey: `wiki-rename:${approval.approvalId}`,
        actor: input.commit?.actor ?? "user:desktop",
        origin: input.commit?.origin ?? { kind: "user", via: "desktop.rename" },
        reason: input.commit?.reason ?? "rename wiki page",
        expectedRevision: plan.baseHead
      },
      [
        movePage(plan.source, plan.newPath, plan.movedContent),
        createPage(plan.redirect.resourceId, plan.redirect.path, plan.redirect.content),
        ...plan.rewrites.map((rewrite) => updatePage(rewrite.resource, rewrite.content))
      ]
    ).pipe(
      Effect.mapError(mapRevisionError("rename", plan.pageId)),
      Effect.map((result) => ({ _tag: "Committed" as const, result })),
      Effect.catch((cause) =>
        cause.reason === "conflict" || cause.reason === "invalid"
          ? Effect.succeed({ _tag: "Uncommitted" as const, cause })
          : Effect.fail(cause)
      )
    )

    if (outcome._tag === "Uncommitted") {
      const resolution =
        outcome.cause.reason === "conflict"
          ? "Wiki changed; reject this request and request the rename again"
          : `Rename could not be applied: ${outcome.cause.message}`
      const released = yield* store
        .releaseApply(approval.approvalId, resolution.slice(0, 4_000))
        .pipe(Effect.mapError(mapStoreError))
      return yield* approvalView(released)
    }
    const finished = yield* store
      .finishApply(approval.approvalId, outcome.result.commit.commitId)
      .pipe(Effect.mapError(mapStoreError))
    return yield* approvalView(finished)
  })

  const rejectRename = Effect.fn("WikiRename.reject")(function* (
    approvalId: string,
    resolution?: string | null
  ) {
    const rejected = yield* store
      .reject(
        approvalId,
        resolution === null || resolution === undefined || resolution.length === 0
          ? undefined
          : resolution
      )
      .pipe(Effect.mapError(mapStoreError))
    return yield* approvalView(rejected)
  })

  return { listRenameApprovals, requestRename, acceptRename, rejectRename }
}
