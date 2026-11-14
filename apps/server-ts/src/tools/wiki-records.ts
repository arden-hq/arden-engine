import { ToolExecutionError } from "@arden-hq/loop"
import { CORE_CONDENSE_ADVICE, coreCondenseTarget, corePageBudget } from "../memory/core-memory.js"
import { memoryHref } from "../lib/memory-link.js"
import type { PageRecord } from "../wiki/snapshot.js"
import type { ServerRunContext } from "./run-context.js"
import { appliedReceipt, type CallIdentity } from "./call-receipt.js"
import { passage } from "./source-passage.js"

export const MAX_PAGE_SOURCES = 50

export const memorySource = (page: {
  readonly path: string
  readonly title: string
  readonly use: "read" | "found"
  readonly body?: string
}) => {
  const paragraph = page.body
    ?.split(/\n\s*\n/)
    .map((block) => block.trim())
    .find(
      (block) =>
        block.length >= 40 &&
        !block.startsWith("#") &&
        !block.startsWith("|") &&
        !block.startsWith("```")
    )
  const excerpt = paragraph === undefined ? undefined : passage(paragraph)
  return {
    provider: "memory",
    kind: "page",
    ref: page.path,
    title: page.title,
    use: page.use,
    href: memoryHref(page.path),
    ...(excerpt === undefined ? {} : { excerpt })
  }
}

export const pageSource = (record: PageRecord, use: "read" | "found") =>
  memorySource({ path: record.resource.path, title: record.page.title, use })

export const pageReceipt = ({
  ctx,
  page,
  beforeVersion
}: {
  readonly ctx: CallIdentity
  readonly page: {
    readonly pageId: string
    readonly path: string
    readonly title: string
    readonly version: string
  }
  readonly beforeVersion: string
}): Readonly<Record<string, unknown>> =>
  appliedReceipt(ctx, {
    kind: "versioned_resource",
    resourceRef: `memory:${page.pageId}`,
    beforeVersion,
    afterVersion: page.version,
    domain: "memory",
    title: page.title,
    href: memoryHref(page.path)
  })

export const pagesReceipt = (
  ctx: CallIdentity,
  pages: ReadonlyArray<{
    readonly pageId: string
    readonly path: string
    readonly title: string
    readonly beforeVersion: string
    readonly afterVersion: string
  }>
): Readonly<Record<string, unknown>> | undefined => {
  const changed = pages.filter((page) => page.beforeVersion !== page.afterVersion)
  return changed.length === 0
    ? undefined
    : appliedReceipt(
        ctx,
        changed.map((page) => ({
          kind: "versioned_resource" as const,
          resourceRef: `memory:${page.pageId}`,
          beforeVersion: page.beforeVersion,
          afterVersion: page.afterVersion,
          domain: "memory" as const,
          title: page.title,
          href: memoryHref(page.path)
        }))
      )
}

export const directoryReceipt = (
  ctx: CallIdentity,
  page: { readonly pageId: string; readonly path: string; readonly title: string }
): Readonly<Record<string, unknown>> =>
  appliedReceipt(ctx, {
    kind: "target",
    resourceRef: `memory:${page.pageId}`,
    domain: "memory",
    title: page.title,
    href: memoryHref(page.path)
  })

export const requireWithinCoreBudget = (page: {
  readonly path: string
  readonly pageId: string
  readonly body: string
}): void => {
  const budget = corePageBudget(page)
  if (budget === undefined || page.body.length <= budget) return
  const target = coreCondenseTarget(budget)
  throw new ToolExecutionError(
    `${page.path} would have ${page.body.length} characters, but every chat receives only the first ${budget}. ` +
      `Nothing was saved. Cut at least ${page.body.length - budget} characters; aim for ${target} or fewer ` +
      `(${page.body.length - target} less) so later updates fit. Trimming a few words will not do it. ` +
      `${CORE_CONDENSE_ADVICE} Then retry with the new fact included.`,
    { preview: "Core Memory page too long", retryable: false }
  )
}

/** The version of a page this run read. A page is changed only after the run has read it. */
export const requireObserved = (ctx: ServerRunContext, record: PageRecord): string => {
  const observed = ctx.observations.observed(record.page.pageId)
  if (observed !== undefined) return observed
  throw new ToolExecutionError(`Read ${record.resource.path} before changing it, then retry.`, {
    preview: "Read required",
    retryable: false
  })
}

/** What a published report says about itself: the period it covers, who made it, its sources. */
export const reportProvenanceLines = (record: PageRecord): ReadonlyArray<string> => [
  ...(typeof record.page.metadata["observation_period"] === "string"
    ? [`Observation period: ${record.page.metadata["observation_period"]}`]
    : []),
  ...(typeof record.page.metadata["producer_automation_id"] === "string"
    ? [`Producer Automation: ${record.page.metadata["producer_automation_id"]}`]
    : []),
  ...(Array.isArray(record.page.metadata["source_refs"])
    ? [
        "Original source references:",
        ...record.page.metadata["source_refs"]
          .filter((ref): ref is string => typeof ref === "string")
          .slice(0, 30)
      ]
    : [])
]
