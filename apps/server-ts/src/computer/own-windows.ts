import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Schema } from "effect"
import { bundleWithin } from "./bundle-id.js"

const ARDEN_BUNDLE_ID = "com.arden.desktop"

const isObject = Schema.is(Schema.Record(Schema.String, Schema.Json))
const isArray = Schema.is(Schema.Array(Schema.Json))

const OWN_WINDOW_REFUSAL =
  "This is Arden's own window, which native control never touches. Use Arden's own tools instead; for connections, call capability_propose."

const isArdenBundle = (bundleId: string | undefined): boolean =>
  bundleId !== undefined && bundleWithin(bundleId, ARDEN_BUNDLE_ID)

const opensArden = (urls: unknown): boolean =>
  Array.isArray(urls) && urls.some((url) => typeof url === "string" && /^\s*arden:/i.test(url))

const isOwnApp = (
  app: { readonly pid?: number | undefined; readonly bundleId?: string | undefined },
  ownPid: number | undefined
): boolean => (ownPid !== undefined && app.pid === ownPid) || isArdenBundle(app.bundleId)

const pidOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined

export const appBundles = (structured: unknown): ReadonlyMap<number, string> => {
  const bundles = new Map<number, string>()
  if (!isObject(structured) || !isArray(structured.apps)) return bundles
  for (const app of structured.apps) {
    if (!isObject(app)) continue
    const pid = pidOf(app.pid)
    if (pid !== undefined && typeof app.bundle_id === "string") bundles.set(pid, app.bundle_id)
  }
  return bundles
}

export const nativeCallRefusal = (
  args: Readonly<Record<string, Schema.Json>>,
  ownPid: number | undefined,
  bundleOfPid: (pid: number) => string | undefined
): string | undefined => {
  if (opensArden(args.urls)) return OWN_WINDOW_REFUSAL
  const pid = pidOf(args.pid)
  const named = typeof args.bundle_id === "string" ? args.bundle_id : undefined
  const bundleId = named ?? (pid === undefined ? undefined : bundleOfPid(pid))
  return isOwnApp({ pid, bundleId }, ownPid) ? OWN_WINDOW_REFUSAL : undefined
}

export const withoutOwnApps = (
  result: CallToolResult,
  ownPid: number | undefined
): CallToolResult => {
  const structured = result.structuredContent
  if (!isObject(structured) || !isArray(structured.apps)) return result
  const apps = structured.apps.filter(
    (app) =>
      !isObject(app) ||
      !isOwnApp({ pid: pidOf(app.pid), bundleId: pickString(app.bundle_id) }, ownPid)
  )
  if (apps.length === structured.apps.length) return result
  return {
    ...result,
    structuredContent: { ...structured, apps },
    content: [{ type: "text", text: `Found ${apps.length} apps` }]
  }
}

const pickString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

export const ownWindowIssue = (input: object, ownPid: number | undefined): string | undefined => {
  const record = new Map(Object.entries(input))
  const target = record.get("target")
  const targetPid =
    typeof target === "object" && target !== null
      ? new Map(Object.entries(target)).get("pid")
      : undefined
  const args: Record<string, Schema.Json> = {}
  const pid = record.get("pid") ?? targetPid
  if (typeof pid === "number") args.pid = pid
  const bundleId = record.get("bundle_id")
  if (typeof bundleId === "string") args.bundle_id = bundleId
  const urls = record.get("urls")
  if (Array.isArray(urls)) args.urls = urls.filter((url): url is string => typeof url === "string")
  return nativeCallRefusal(args, ownPid, () => undefined)
}

const namedWindow = (
  args: Readonly<Record<string, Schema.Json>>
): { readonly pid: number; readonly windowId: number } | undefined => {
  const pid = pidOf(args.pid)
  const windowId = pidOf(args.window_id)
  return pid === undefined || windowId === undefined ? undefined : { pid, windowId }
}

const windowIdsOf = (listing: CallToolResult, pid: number): ReadonlySet<number> => {
  const structured = listing.isError ? undefined : listing.structuredContent
  if (!isObject(structured) || !isArray(structured.windows)) return new Set()
  return new Set(
    structured.windows.flatMap((window) =>
      isObject(window) && pidOf(window.pid) === pid && pidOf(window.window_id) !== undefined
        ? [pidOf(window.window_id) ?? 0]
        : []
    )
  )
}

const NOT_THAT_APPS_WINDOW =
  "That window is not one of that app's windows. List the app's windows with computer_read again."

const windowCallIssue = async (
  target: { readonly pid: number; readonly windowId: number },
  ownPid: number | undefined,
  listWindows: (pid: number) => Promise<CallToolResult>
): Promise<string | undefined> => {
  if (
    ownPid !== undefined &&
    (await listWindows(ownPid).then((own) => windowIdsOf(own, ownPid))).has(target.windowId)
  )
    return OWN_WINDOW_REFUSAL
  return windowIdsOf(await listWindows(target.pid), target.pid).has(target.windowId)
    ? undefined
    : NOT_THAT_APPS_WINDOW
}

const answersAnotherWindow = (
  target: { readonly pid: number; readonly windowId: number },
  result: CallToolResult
): boolean => {
  const structured = result.structuredContent
  if (!isObject(structured)) return false
  const pid = structured.pid
  const windowId = structured.window_id
  return (
    (pid !== undefined && pid !== target.pid) ||
    (windowId !== undefined && windowId !== target.windowId)
  )
}

const ANOTHER_WINDOW_ANSWER =
  "The driver answered for a different window than the one asked, so Arden dropped its answer. Observe the window again."

export const windowCall = async (
  name: string,
  args: Readonly<Record<string, Schema.Json>>,
  ownPid: number | undefined,
  send: (name: string, args: Readonly<Record<string, Schema.Json>>) => Promise<CallToolResult>
): Promise<CallToolResult> => {
  const target = namedWindow(args)
  if (target === undefined) return send(name, args)
  const issue = await windowCallIssue(target, ownPid, (pid) => send("list_windows", { pid }))
  if (issue !== undefined) return { isError: true, content: [{ type: "text", text: issue }] }
  const result = await send(name, args)
  return answersAnotherWindow(target, result)
    ? { isError: true, content: [{ type: "text", text: ANOTHER_WINDOW_ANSWER }] }
    : result
}
