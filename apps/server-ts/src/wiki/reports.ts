import { WIKI_REPORT_FIELDS } from "@arden-hq/protocol/wiki"
import type { ManagedFileRepositoryShape } from "@arden-hq/revisions/effect"
import { Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { posix } from "node:path"

import type { SpaceStore } from "../persistence/spaces/store.js"
import { canonicalWikiPath } from "./authority.js"
import { commitWiki, createPage, updatePage } from "./commit.js"
import { mapRevisionError, wikiError, type WikiError } from "./errors.js"
import { ObservationPeriodSchema, formatObservationPeriod } from "./observation-period.js"
import { formatWikiPage, normal, pageNamesForPath, parseWikiPage } from "./page.js"
import { loadSnapshot } from "./snapshot.js"

export const WikiReportContentSchema = Schema.Struct({
  path: Schema.NonEmptyString.check(Schema.isMaxLength(4_096)),
  title: Schema.NonEmptyString.check(Schema.isMaxLength(4_096)),
  body: Schema.NonEmptyString.check(Schema.isMaxLength(40_000)),
  period: ObservationPeriodSchema,
  sources: Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(2_000))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(30)
  )
})

export interface WikiPublishReportInput extends Schema.Schema.Type<typeof WikiReportContentSchema> {
  readonly producerAutomationId: string
  readonly runId: string
  readonly producerChainDepth?: number
  readonly expectedVersion: string | undefined
}

const unwrapSourceUrl = (source: string): string =>
  /^https?:\/\//iu.test(source.trim()) ? source.replace(/\s+/gu, "") : source

export const publishWikiReport = Effect.fn("Wiki.publishReport")(function* (
  repository: ManagedFileRepositoryShape,
  spaces: SpaceStore["Service"],
  input: WikiPublishReportInput
): Effect.fn.Return<{ readonly pageId: string; readonly changed: boolean }, WikiError> {
  const decoded = yield* Schema.decodeUnknownEffect(WikiReportContentSchema)(input).pipe(
    Effect.mapError((cause) => wikiError("create", "invalid", "Invalid report content", { cause }))
  )
  const content = {
    ...decoded,
    period: formatObservationPeriod(decoded.period),
    sources: decoded.sources.map(unwrapSourceUrl)
  }
  const directory = posix.dirname(content.path)
  if (
    canonicalWikiPath(content.path) === undefined ||
    !content.path.endsWith(".md") ||
    directory === "." ||
    posix.basename(content.path).toLowerCase() === "readme.md"
  ) {
    return yield* wikiError(
      "create",
      "invalid",
      "Publish one .md report inside a configured destination"
    )
  }
  const snapshot = yield* loadSnapshot(repository, "create")
  const contract = snapshot.pages.find(
    (record) =>
      record.resource.path.toLowerCase() === `${directory}/readme.md`.toLowerCase() &&
      record.page.lifecycle === "active"
  )
  if (contract?.page.metadata[WIKI_REPORT_FIELDS.automationId] !== input.producerAutomationId) {
    return yield* wikiError(
      "create",
      "blocked",
      "This Automation does not own the report destination"
    )
  }
  const spaceOwned = yield* spaces
    .ownsWikiPath(content.path)
    .pipe(
      Effect.mapError((cause) =>
        wikiError("create", "storage", "Could not check Space ownership", { cause })
      )
    )
  if (spaceOwned)
    return yield* wikiError("create", "blocked", "Reports cannot claim a Space-owned path")
  const names = new Set(pageNamesForPath(content.path).map(normal))
  const current = snapshot.pages.find((record) =>
    pageNamesForPath(record.resource.path).some((name) => names.has(normal(name)))
  )
  if (
    current !== undefined &&
    (current.resource.path !== content.path ||
      current.page.lifecycle !== "active" ||
      current.page.metadata[WIKI_REPORT_FIELDS.automationId] !== input.producerAutomationId)
  ) {
    return yield* wikiError("create", "blocked", "The report path belongs to another record")
  }
  if (
    current !== undefined &&
    current.page.title === content.title &&
    current.page.body === content.body &&
    current.page.metadata[WIKI_REPORT_FIELDS.period] === content.period &&
    JSON.stringify(current.page.metadata[WIKI_REPORT_FIELDS.sources]) ===
      JSON.stringify(content.sources)
  ) {
    return { pageId: current.page.pageId, changed: false }
  }
  if (current !== undefined && current.resource.versionId !== input.expectedVersion) {
    return yield* wikiError("update", "conflict", "Read the current report before replacing it")
  }
  const pageId = current?.page.pageId ?? randomUUID()
  const formatted = formatWikiPage({
    pageId,
    title: content.title,
    aliases: current?.page.aliases ?? [],
    lifecycle: "active",
    redirectTo: null,
    metadata: {
      ...current?.page.metadata,
      [WIKI_REPORT_FIELDS.automationId]: input.producerAutomationId,
      [WIKI_REPORT_FIELDS.runId]: input.runId,
      [WIKI_REPORT_FIELDS.period]: content.period,
      [WIKI_REPORT_FIELDS.sources]: [...content.sources]
    },
    body: content.body
  })
  yield* parseWikiPage(formatted, pageId).pipe(
    Effect.mapError((cause) => wikiError("create", "invalid", cause.message, { cause }))
  )
  yield* commitWiki(
    repository,
    {
      expectedRevision: snapshot.head,
      actor: `Automation ${input.producerAutomationId}`,
      origin: {
        kind: "automation",
        automationId: input.producerAutomationId,
        ...(input.producerChainDepth === undefined ? {} : { chainDepth: input.producerChainDepth })
      },
      reason: `Publish report ${content.path}`
    },
    [
      current === undefined
        ? createPage(pageId, content.path, formatted)
        : updatePage(current.resource, formatted)
    ]
  ).pipe(Effect.mapError(mapRevisionError("create")))
  return { pageId, changed: true }
})
