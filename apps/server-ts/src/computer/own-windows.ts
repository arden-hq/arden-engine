import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Schema } from "effect"

/** The installed desktop app. A dev build runs as `com.github.Electron`, which
 *  every other Electron app shares, so a dev build is known by its process id
 *  alone and that bundle id is never refused. */
const ARDEN_BUNDLE_ID = "com.arden.desktop"

const isObject = Schema.is(Schema.Record(Schema.String, Schema.Json))
const isArray = Schema.is(Schema.Array(Schema.Json))

const OWN_WINDOW_REFUSAL =
  "This is Arden's own window, which native control never touches. Use Arden's own tools instead; for connections, call capability_propose."

const isArdenBundle = (bundleId: string | undefined): boolean => {
  const id = bundleId?.toLowerCase()
  return id === ARDEN_BUNDLE_ID || id?.startsWith(`${ARDEN_BUNDLE_ID}.`) === true
}

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
