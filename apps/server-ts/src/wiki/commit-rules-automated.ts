import type { ManagedFileRepositoryShape, RevisionError } from "@arden-hq/revisions/effect"
import { PATH_SEGMENT, RESOURCE_STATE } from "@arden-hq/revisions/effect"
import { WIKI_PAGE_LIFECYCLE } from "@arden-hq/protocol/wiki"
import { Effect, Option } from "effect"
import { posix } from "node:path"

import { producingAutomation } from "./collections.js"
import type { CommitView, ResolvedWrite } from "./commit-rule-types.js"
import { ruleError } from "./commit-rule-types.js"
import { WIKI_PAGE_ACTION, decoder, type WikiCommitError } from "./commit-write-types.js"
import { isProducer } from "./origin.js"
import { parseWikiPage } from "./page.js"

export const requireAutomatedRecordWrite = Effect.fn("Wiki.requireAutomatedRecordWrite")(function* (
  { origin, folders }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  switch (write.action) {
    case WIKI_PAGE_ACTION.edit:
    case WIKI_PAGE_ACTION.restoreVersion:
    case WIKI_PAGE_ACTION.restoreArchived:
      return
    case WIKI_PAGE_ACTION.create:
    case WIKI_PAGE_ACTION.newPage:
    case WIKI_PAGE_ACTION.publish: {
      if (write.before !== null || write.path.after === undefined) return
      const producer = producingAutomation(yield* folders, write.path.after)
      if (
        producer === undefined ||
        (write.action === WIKI_PAGE_ACTION.publish && isProducer(origin, producer))
      )
        return
      return yield* ruleError(
        "records",
        `${write.path.after} is in the record folder of Automation ${producer}; only that Automation adds pages to it, by publishing reports. Nothing was saved.`
      )
    }
    case WIKI_PAGE_ACTION.move:
    case WIKI_PAGE_ACTION.archive:
    case WIKI_PAGE_ACTION.merge: {
      if (write.path.before === undefined) return
      const producer = producingAutomation(yield* folders, write.path.before)
      if (producer === undefined) return
      return yield* ruleError(
        "records",
        `${write.path.before} belongs to the record folder of Automation ${producer}. An Automation run does not move, archive or merge away its pages. Nothing was saved.`
      )
    }
  }
})

export const requireAutomatedRetirement = Effect.fn("Wiki.requireAutomatedRetirement")(function* (
  { repository }: CommitView,
  write: ResolvedWrite
): Effect.fn.Return<void, WikiCommitError> {
  if (write.action !== WIKI_PAGE_ACTION.archive && write.action !== WIKI_PAGE_ACTION.merge) return
  const path = write.path.before
  if (path === undefined) return
  if (posix.dirname(path) === PATH_SEGMENT.current) {
    return yield* ruleError(
      "retire",
      `${path} is at the Memory root. An Automation run does not archive or merge it. Nothing was saved.`
    )
  }
  if (write.action === WIKI_PAGE_ACTION.merge && (yield* wasUnmerged(repository, write.resourceId)))
    return yield* ruleError(
      "retire",
      `${path} was merged before and then restored, so it stays its own page. Leave it.`
    )
})

const wasUnmerged = Effect.fn("Wiki.wasUnmerged")(function* (
  repository: ManagedFileRepositoryShape,
  resourceId: string
): Effect.fn.Return<boolean, RevisionError> {
  for (const commit of yield* repository.history({ resourceId, limit: null })) {
    const version = commit.changes.find(
      (change) => (change.after ?? change.before)?.resourceId === resourceId
    )?.after
    if (version === undefined || version === null || version.state !== RESOURCE_STATE.active)
      continue
    const earlier = yield* parseWikiPage(
      decoder.decode(yield* repository.readVersion(version))
    ).pipe(Effect.option)
    if (Option.isSome(earlier) && earlier.value.lifecycle === WIKI_PAGE_LIFECYCLE.redirect)
      return true
  }
  return false
})
