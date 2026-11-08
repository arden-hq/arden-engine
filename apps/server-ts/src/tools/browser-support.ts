import { countOf } from "@arden-hq/std/count"
import { ToolExecutionError, type ToolResultOutput } from "@arden-hq/loop"
import { Effect, Schema } from "effect"

import {
  BrowserClientError,
  type BrowserClient,
  type BrowserOutput,
  type BrowserRequest
} from "../browser/service.js"
import type { CallEffects } from "../execution/tool-effect.js"
import { browserTarget, hostOf, pageLink, type BrowserElement } from "./action-targets.js"
import { sharedResourceSessions, type RunAuthority } from "../execution/authority.js"
import type { BrowserObservationRegistry } from "./run-context.js"

export { ProfileRefSchema, TabRefSchema } from "../browser/service.js"
export const OriginSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048))

export const webUrl = (url: string): URL | undefined => {
  if (!URL.canParse(url)) return undefined
  const parsed = new URL(url)
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined
}

export const atNodeRef = (nodeRef: string): string =>
  nodeRef.startsWith("@") ? nodeRef : `@${nodeRef}`

export const originIssues = (input: string): Array<Schema.FilterIssue> =>
  webUrl(input)?.origin === input
    ? []
    : [{ path: ["origin"], issue: "must be an exact HTTP origin without a path" }]

export const requireObservedRevision = (revision: number | undefined): number => {
  if (revision !== undefined) return revision
  throw toolFailure(
    new BrowserClientError({
      code: "browser_snapshot_required",
      message: "Take a fresh interactive snapshot of this tab before acting",
      retryable: true,
      outcomeUnknown: false
    })
  )
}

export const claimObservedRevision = (
  observations: BrowserObservationRegistry,
  tabRef: string,
  snapshotRef: string,
  toolCallId: string
): number => {
  const claim = observations.consume(tabRef, snapshotRef, toolCallId)
  switch (claim.kind) {
    case "leased":
      throw tabInUse()
    case "claimed":
      return claim.revision
    case "missing":
      return requireObservedRevision(undefined)
    case "other":
      throw toolFailure(
        new BrowserClientError({
          code: "stale_browser_snapshot",
          message: `${snapshotRef} is not the latest snapshot of this tab, so nothing was done. Build the action from the latest one: the last browser_snapshot, or the page the last action returned.`,
          retryable: true,
          outcomeUnknown: false
        })
      )
  }
}

const requireTabFree = (
  observations: BrowserObservationRegistry,
  tabRef: string,
  toolCallId: string | undefined
): void => {
  if (!observations.mayUse(tabRef, toolCallId)) throw tabInUse()
}

export const tabInUse = (): ToolExecutionError =>
  new ToolExecutionError(
    "A browser task is working in this tab; its result, with the page, arrives here. Wait for it, or use another tab.",
    { preview: "Tab in use by a task", retryable: true }
  )

const STALE_PREVIEW = "Page changed"

export const isStaleRead = (cause: unknown): boolean =>
  cause instanceof ToolExecutionError && cause.preview === STALE_PREVIEW

const failurePreview = (error: BrowserClientError): string => {
  if (error.outcomeUnknown)
    return "A step in the browser didn't confirm it finished — Arden checks the page before continuing"
  if (error.code === "browser_snapshot_required") return "Fresh snapshot required"
  if (error.code === "stale_browser_snapshot") return STALE_PREVIEW
  if (error.code === "browser_unavailable") return "Browser unavailable"
  return "Browser request failed"
}

const toolFailure = (error: BrowserClientError): ToolExecutionError =>
  new ToolExecutionError(error.message, {
    preview: failurePreview(error),
    retryable: error.outcomeUnknown ? false : error.retryable
  })

export const browserOutput = (value: BrowserOutput): ToolResultOutput => ({
  result: value.result,
  preview: value.preview,
  ...(value.data === undefined ? {} : { data: value.data }),
  ...(value.modelContent === undefined ? {} : { model_content: value.modelContent })
})

const sharedBrowserSessionIds = (authority: RunAuthority): ReadonlyArray<string> =>
  sharedResourceSessions(authority, "browser").map((resource) => resource.session_id)

export interface BrowserCaller {
  readonly run: {
    readonly sessionId: string
    readonly authority: RunAuthority
    readonly browserObservations: BrowserObservationRegistry
    readonly mayUseBrowserTab: (tabRef: string, toolCallId: string | undefined) => Promise<boolean>
  }
  readonly toolCallId?: string
}

export interface BrowserWrite {
  readonly effects: CallEffects
  readonly element?: BrowserElement
}

export const runBrowserForRun = async (
  browser: BrowserClient["Service"],
  { run, toolCallId }: BrowserCaller,
  operation: BrowserRequest["operation"],
  signal: AbortSignal,
  write?: BrowserWrite
): Promise<BrowserOutput> => {
  if ("tabRef" in operation && operation.tabRef !== undefined) {
    if (!(await run.mayUseBrowserTab(operation.tabRef, toolCallId))) throw tabInUse()
    requireTabFree(run.browserObservations, operation.tabRef, toolCallId)
  }
  const shared = sharedBrowserSessionIds(run.authority)
  if (write === undefined)
    return runBrowser(browser, run.sessionId, operation, signal, undefined, shared)
  const named = browserTarget(operation, write.element)
  if (named !== undefined) await write.effects.target(named)
  const output = await runBrowser(browser, run.sessionId, operation, signal, write.effects, shared)
  const page = reportedPage(output)
  if (named !== undefined && page !== undefined) {
    const site = named.place ?? hostOf(page)
    await write.effects.created({
      ...named,
      href: page,
      ...(site === undefined ? {} : { place: site })
    })
  }
  return output
}

const ReportedTabSchema = Schema.Struct({ tab: Schema.Struct({ url: Schema.String }) })

const reportedPage = (output: BrowserOutput): string | undefined => {
  const reported = Schema.decodeUnknownOption(ReportedTabSchema)(output.data)
  if (reported._tag === "None") return undefined
  return pageLink(reported.value.tab.url)
}

const runBrowser = (
  browser: BrowserClient["Service"],
  sessionId: string,
  operation: BrowserRequest["operation"],
  signal: AbortSignal,
  effects?: CallEffects,
  sharedSessionIds: ReadonlyArray<string> = []
): Promise<BrowserOutput> => {
  const execute = (ownerSessionId: string, request = operation) =>
    Effect.runPromise(
      browser.execute({ sessionId: ownerSessionId, operation: request }, signal).pipe(
        Effect.tap(() => Effect.sync(() => effects?.applied())),
        Effect.tapError((error) =>
          Effect.sync(() => (error.outcomeUnknown ? effects?.sent() : effects?.unchanged()))
        ),
        Effect.mapError(toolFailure)
      ),
      { signal }
    )

  const owners = [...new Set([sessionId, ...sharedSessionIds])]
  if (operation.type === "tabs") {
    return Promise.all(owners.map((owner) => execute(owner))).then((outputs) => {
      const tabs = [
        ...new Map(
          outputs
            .flatMap((output, index) =>
              decodedTabs(output).filter(
                (tab) => index === 0 || tab["session_ref"] === owners[index]
              )
            )
            .map((tab) => [tab.tab_ref, tab])
        ).values()
      ]
      const lines = tabs.map(
        (tab) => `${tab.selected ? "*" : "-"} ${tab.tab_ref} — ${tab.title} — ${tab.url}`
      )
      return {
        result: lines.length === 0 ? "No browser tabs are open." : lines.join("\n"),
        preview: `${countOf(tabs.length, "browser tab")}`,
        data: { tabs }
      }
    })
  }
  if (operation.type === "site_secrets") {
    return Promise.all(owners.map((owner) => execute(owner))).then((outputs) => {
      const names = [...new Set(outputs.flatMap((output) => decodedNames(output)))]
      return {
        result: names.length === 0 ? "No saved secrets for this site." : names.join("\n"),
        preview: `${countOf(names.length, "saved secret")}`,
        data: { names }
      }
    })
  }
  const tabRef = operationTabRef(operation)
  if (tabRef === undefined || owners.length === 1) return execute(sessionId)
  return resolveOwner(browser, owners, tabRef, signal).then((owner) => {
    if (owner === undefined)
      throw toolFailure(
        new BrowserClientError({
          code: "invalid_tab_ref",
          message: "The tab does not belong to this browser or a granted shared Session",
          retryable: false,
          outcomeUnknown: false
        })
      )
    return execute(owner)
  })
}

const PublicTabSchema = Schema.Struct({
  tab_ref: Schema.String,
  profile_ref: Schema.String,
  title: Schema.String,
  url: Schema.String,
  loading: Schema.Boolean,
  sleeping: Schema.Boolean,
  favicon_url: Schema.NullOr(Schema.String),
  selected: Schema.Boolean,
  ownership: Schema.Literals(["agent", "user"]),
  revision: Schema.Number,
  session_ref: Schema.NullOr(Schema.String)
})

const decodedTabs = (output: BrowserOutput): ReadonlyArray<Record<string, unknown>> => {
  const value = output.data?.["tabs"]
  if (!Array.isArray(value)) return []
  const valid = Schema.decodeUnknownOption(Schema.Array(PublicTabSchema))(value)
  if (valid._tag === "None") return []
  return value.filter(
    (tab): tab is Record<string, unknown> =>
      typeof tab === "object" &&
      tab !== null &&
      !Array.isArray(tab) &&
      Schema.is(PublicTabSchema)(tab)
  )
}

const decodedNames = (output: BrowserOutput) => {
  const value = output.data?.["names"]
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string")
    : []
}

const operationTabRef = (operation: BrowserRequest["operation"]): string | undefined => {
  switch (operation.type) {
    case "pointer":
    case "close":
    case "snapshot":
    case "screenshot":
    case "target":
    case "act":
    case "upload":
    case "wait":
    case "permission":
      return operation.tabRef
    case "open":
      return operation.disposition === "current" ? operation.tabRef : undefined
    case "tabs":
    case "site_secrets":
      return undefined
  }
}

const resolveOwner = async (
  browser: BrowserClient["Service"],
  owners: ReadonlyArray<string>,
  tabRef: string,
  signal: AbortSignal
): Promise<string | undefined> => {
  for (const owner of owners) {
    const output = await Effect.runPromise(
      browser.execute({ sessionId: owner, operation: { type: "tabs" } }, signal),
      { signal }
    )
    if (
      decodedTabs(output).some(
        (tab) => tab.tab_ref === tabRef && (owner === owners[0] || tab["session_ref"] === owner)
      )
    )
      return owner
  }
  return undefined
}
