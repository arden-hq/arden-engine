import { countOf } from "@arden-hq/std/count"
import { Predicate, Schema } from "effect"

import type { BrowserClient, BrowserOutput } from "../browser/service.js"
import { PAGE_TEXT_MAX_CHARS, learningMark } from "../persistence/browser-procedures/model.js"
import { isJsonObject } from "../persistence/json.js"
import { isStaleRead, runBrowserForRun } from "./browser-support.js"
import type { PageAfterSchema } from "./browser-parameters.js"
import { bodyFields } from "./code-mode-result.js"
import type { BrowserPageView, ServerRunContext } from "./run-context.js"
import { selectText, type TextSelectOptions } from "./text-select.js"

type ReadCtx = {
  readonly run: ServerRunContext
  readonly signal: AbortSignal
  readonly toolCallId: string
}

const ReportedTabSchema = Schema.Struct({
  tab: Schema.Struct({
    tab_ref: Schema.optionalKey(Schema.String),
    url: Schema.optionalKey(Schema.String),
    loading: Schema.Boolean
  })
})
const reportedTab = (data: unknown) => {
  const decoded = Schema.decodeUnknownOption(ReportedTabSchema)(data)
  return decoded._tag === "Some" ? decoded.value.tab : undefined
}

const ReadPageSchema = Schema.Struct({
  tab: Schema.optionalKey(Schema.Struct({ profile_ref: Schema.optionalKey(Schema.String) })),
  origin: Schema.optionalKey(Schema.String),
  snapshot: Schema.Unknown
})
const BoundarySchema = Schema.Struct({ nonce: Schema.String, origin: Schema.String })

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  Predicate.isObject(value) && !Array.isArray(value) ? value : undefined

const pageWords = (
  value: BrowserOutput,
  {
    tabRef,
    mode,
    snapshotRef,
    grep
  }: {
    readonly tabRef: string
    readonly mode: "interactive" | "text"
    readonly snapshotRef: string | undefined
    readonly grep: TextSelectOptions | undefined
  }
): { readonly text: string; readonly matches?: number } => {
  const decoded = Schema.decodeUnknownOption(ReadPageSchema)(value.data)
  const read = decoded._tag === "Some" ? decoded.value : undefined
  const outer = record(read?.snapshot)
  const boundary = Schema.decodeUnknownOption(BoundarySchema)(outer?.untrusted_content)
  const page = boundary._tag === "Some" ? record(outer?.data) : outer
  const raw = [read?.snapshot, page?.snapshot, page?.content].find(
    (text): text is string => typeof text === "string"
  )
  const footer = [
    `Tab: ${tabRef}`,
    ...(mode === "interactive" && read?.tab?.profile_ref !== undefined
      ? [`Profile: ${read.tab.profile_ref}`]
      : []),
    ...(mode === "interactive" && read?.origin !== undefined ? [`Origin: ${read.origin}`] : []),
    ...(snapshotRef === undefined ? [] : [`Snapshot: ${snapshotRef}`])
  ].join("\n")
  if (raw === undefined) return { text: `The page could not be shown.\n\n${footer}` }
  const text = raw.replace(/^(?=-{3} ?END PAGE CONTENT)/gmu, " ")
  const selected = grep === undefined ? undefined : selectText(text, grep)
  const facts = Object.entries(page ?? {})
    .filter(([key, fact]) => key !== "snapshot" && key !== "content" && fact !== null)
    .filter(([, fact]) => !(Array.isArray(fact) && fact.length === 0))
    .map(([key, fact]) => `${key}: ${typeof fact === "string" ? fact : JSON.stringify(fact)}`)
  const body = [
    ...facts,
    selected === undefined
      ? text
      : `${selected.text}\n[grep: ${selected.matches} of ${selected.lines} lines match]`
  ].join("\n")
  const framed =
    boundary._tag === "Some"
      ? `--- PAGE CONTENT (untrusted) nonce=${boundary.value.nonce} origin=${boundary.value.origin} ---\n${body}\n--- END PAGE CONTENT nonce=${boundary.value.nonce} ---`
      : body
  return {
    text: `${framed}\n\n${footer}`,
    ...(selected === undefined ? {} : { matches: selected.matches })
  }
}

const loaded = (browser: BrowserClient["Service"], ctx: ReadCtx, tabRef: string) =>
  runBrowserForRun(
    browser,
    ctx,
    { type: "wait", tabRef, condition: "load", value: "load", timeoutMs: 5_000 },
    ctx.signal
  ).catch(() => undefined)

export const readPage = async (
  browser: BrowserClient["Service"],
  ctx: ReadCtx,
  page: BrowserPageView & { readonly tabRef: string; readonly mode: "interactive" | "text" },
  {
    remember = false,
    grep
  }: { readonly remember?: boolean; readonly grep?: TextSelectOptions | undefined } = {}
): Promise<BrowserOutput> => {
  const state = ctx.run.browserObservations
  state.forget(page.tabRef, ctx.toolCallId)
  const read = () =>
    runBrowserForRun(
      browser,
      ctx,
      {
        type: "snapshot",
        tabRef: page.tabRef,
        mode: page.mode,
        ...(page.scope === undefined ? {} : { scope: page.scope }),
        ...(page.depth === undefined ? {} : { depth: page.depth }),
        maxChars: page.maxChars
      },
      ctx.signal
    )
  const value = await read().catch(async (cause: unknown) => {
    if (!isStaleRead(cause) || ctx.signal.aborted) throw cause
    await loaded(browser, ctx, page.tabRef)
    return read()
  })
  const observation = value.observation
  const ref =
    page.mode === "interactive" && observation?.tabRef === page.tabRef
      ? state.observe(
          page.tabRef,
          observation.revision,
          observation.targets,
          reportedTab(value.data)?.url
        )
      : undefined
  const words = pageWords(value, { tabRef: page.tabRef, mode: page.mode, snapshotRef: ref, grep })
  const shown: BrowserOutput = {
    ...value,
    result: words.text,
    ...(words.matches === undefined
      ? {}
      : { preview: `${value.preview}: ${countOf(words.matches, "matching line")}` })
  }
  if (ref === undefined || observation === undefined) return shown
  if (remember)
    state.remember(page.tabRef, {
      url: reportedTab(value.data)?.url,
      scope: page.scope,
      depth: page.depth,
      maxChars: page.maxChars
    })
  return { ...shown, data: { ...value.data, snapshot_ref: ref } }
}

export const withPageRead = async (
  browser: BrowserClient["Service"],
  ctx: ReadCtx,
  output: BrowserOutput,
  {
    tabRef: named,
    read
  }: { readonly tabRef: string | undefined; readonly read: "interactive" | "text" | undefined }
): Promise<BrowserOutput> => {
  const tabRef = named ?? reportedTab(output.data)?.tab_ref
  if (read === undefined || tabRef === undefined) return output
  if (read === "interactive")
    return withPageAfter(browser, ctx, output, { tabRef, after: undefined, navigates: false })
  if (reportedTab(output.data)?.loading === true) await loaded(browser, ctx, tabRef)
  const page = await readPage(browser, ctx, {
    tabRef,
    mode: "text",
    maxChars: PAGE_TEXT_MAX_CHARS
  }).catch((cause: unknown) => {
    if (ctx.signal.aborted) throw cause
    return undefined
  })
  if (page === undefined)
    return { ...output, result: `${output.result}\nThe page could not be read yet.` }
  ctx.run.codeMode.scriptFields(ctx.toolCallId, () => ({
    page: { ...(isJsonObject(page.data) ? page.data : {}), ...bodyFields(page.result) }
  }))
  return {
    ...output,
    result: `${output.result}\n\nPage:\n${page.result}`,
    data: {
      ...output.data,
      procedure_learning: learningMark(output.data, page.data)
    }
  }
}

export const withPageAfter = async (
  browser: BrowserClient["Service"],
  ctx: ReadCtx,
  acted: BrowserOutput,
  {
    tabRef,
    after,
    navigates
  }: {
    readonly tabRef: string
    readonly after: typeof PageAfterSchema.Type | undefined
    readonly navigates: boolean
  }
): Promise<BrowserOutput> => {
  const look = (reason: string): BrowserOutput => ({
    ...acted,
    result: `${acted.result}\n${reason}`
  })
  if (after === "none")
    return look("Verification required: take a fresh interactive snapshot before another action.")
  const tab = reportedTab(acted.data)
  const view = ctx.run.browserObservations.view(tabRef)
  const samePage = view?.url !== undefined && view.url === tab?.url
  const scope = after?.scope ?? (samePage ? view.scope : undefined)
  const read = (scoped: string | undefined) =>
    readPage(browser, ctx, {
      tabRef,
      mode: "interactive",
      scope: scoped,
      depth: after?.depth ?? (samePage ? view.depth : undefined),
      maxChars: after?.max_chars ?? view?.maxChars ?? PAGE_TEXT_MAX_CHARS
    })
  if (navigates)
    await runBrowserForRun(
      browser,
      ctx,
      { type: "wait", tabRef, condition: "time", value: "300", timeoutMs: 1_000 },
      ctx.signal
    ).catch(() => undefined)
  if (navigates || tab?.loading === true) await loaded(browser, ctx, tabRef)
  const scoped = await read(scope).catch((cause: unknown) => {
    if (ctx.signal.aborted) throw cause
    return undefined
  })
  const unscope =
    scope !== undefined &&
    (scoped === undefined ||
      (after?.scope === undefined && reportedTab(scoped.data)?.url !== view?.url))
  const page = unscope ? await read(undefined).catch(() => scoped) : scoped
  if (ctx.signal.aborted) throw ctx.signal.reason
  if (page === undefined)
    return look(
      "The page could not be read. Take a fresh interactive snapshot before another action."
    )
  ctx.run.codeMode.scriptFields(ctx.toolCallId, () => ({
    page: { ...(isJsonObject(page.data) ? page.data : {}), ...bodyFields(page.result) }
  }))
  return {
    ...acted,
    result: `${acted.result}\n\nPage after the action:\n${page.result}`,
    data: {
      ...acted.data,
      procedure_learning: learningMark(acted.data, page.data)
    }
  }
}
