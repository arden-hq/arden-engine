const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])

export const isLoopbackHost = (host: string): boolean =>
  LOOPBACK_HOSTS.has(host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host)

export const WEB_PROTOCOL = { http: "http:", https: "https:" } as const

export type WebProtocol = (typeof WEB_PROTOCOL)[keyof typeof WEB_PROTOCOL]

const WEB_PROTOCOLS: ReadonlySet<string> = new Set<WebProtocol>(Object.values(WEB_PROTOCOL))

export const isWebProtocol = (protocol: string): protocol is WebProtocol =>
  WEB_PROTOCOLS.has(protocol)

export const SERVER_URL_ISSUE = {
  invalid: "invalid",
  credentials: "credentials",
  fragment: "fragment",
  insecure: "insecure"
} as const

export type ServerUrlIssue = (typeof SERVER_URL_ISSUE)[keyof typeof SERVER_URL_ISSUE]

export const PLAIN_HTTP = { loopback: "loopback", never: "never", any: "any" } as const

export type PlainHttp = (typeof PLAIN_HTTP)[keyof typeof PLAIN_HTTP]

export const serverUrlIssue = (
  raw: string,
  { http = PLAIN_HTTP.loopback }: { readonly http?: PlainHttp } = {}
): ServerUrlIssue | undefined => {
  if (!URL.canParse(raw)) return SERVER_URL_ISSUE.invalid
  const url = new URL(raw)
  if (url.username !== "" || url.password !== "") return SERVER_URL_ISSUE.credentials
  if (url.hash !== "") return SERVER_URL_ISSUE.fragment
  if (url.protocol === WEB_PROTOCOL.https) return undefined
  if (url.protocol !== WEB_PROTOCOL.http) return SERVER_URL_ISSUE.insecure
  return http === PLAIN_HTTP.any || (http === PLAIN_HTTP.loopback && isLoopbackHost(url.hostname))
    ? undefined
    : SERVER_URL_ISSUE.insecure
}

export const BASE_URL_ISSUE = { ...SERVER_URL_ISSUE, query: "query" } as const

export type BaseUrlIssue = (typeof BASE_URL_ISSUE)[keyof typeof BASE_URL_ISSUE]

export const baseUrlIssue = (
  raw: string,
  options?: { readonly http?: PlainHttp }
): BaseUrlIssue | undefined => {
  const issue = serverUrlIssue(raw, options)
  if (issue !== undefined) return issue
  if (raw.includes("#")) return SERVER_URL_ISSUE.fragment
  return raw.includes("?") ? BASE_URL_ISSUE.query : undefined
}

export const isSecureServerUrl = (
  raw: string,
  options?: { readonly http?: Exclude<PlainHttp, typeof PLAIN_HTTP.any> }
): boolean => serverUrlIssue(raw, options) === undefined

const MAX_WEB_URL = 4_096

export const WEB_URL_ISSUE = {
  invalid: "invalid",
  scheme: "scheme",
  credentials: "credentials",
  too_long: "too_long"
} as const

export type WebUrlIssue = (typeof WEB_URL_ISSUE)[keyof typeof WEB_URL_ISSUE]

export const PUBLIC_WEB_URL = { ok: "ok", refused: "refused" } as const

export type PublicWebUrl =
  | { readonly kind: typeof PUBLIC_WEB_URL.ok; readonly url: URL }
  | { readonly kind: typeof PUBLIC_WEB_URL.refused; readonly issue: WebUrlIssue }

export const publicWebUrl = (raw: string, base?: string | URL): PublicWebUrl => {
  if (!URL.canParse(raw, base?.toString())) return refused(WEB_URL_ISSUE.invalid)
  const url = new URL(raw, base)
  if (!isWebProtocol(url.protocol)) return refused(WEB_URL_ISSUE.scheme)
  if (url.username !== "" || url.password !== "") return refused(WEB_URL_ISSUE.credentials)
  if (raw.length > MAX_WEB_URL || url.href.length > MAX_WEB_URL)
    return refused(WEB_URL_ISSUE.too_long)
  url.hash = ""
  return { kind: PUBLIC_WEB_URL.ok, url }
}

export const isPublicWebUrl = (raw: string): boolean => publicWebUrl(raw).kind === PUBLIC_WEB_URL.ok

const refused = (issue: WebUrlIssue): PublicWebUrl => ({ kind: PUBLIC_WEB_URL.refused, issue })

export const webSourceTitle = (title: string, url: string): string | undefined => {
  const page = publicWebUrl(url)
  if (page.kind !== PUBLIC_WEB_URL.ok) return undefined
  const own = title.trim()
  const bare = own.toLowerCase().replace(/^www\./, "")
  const host = page.url.hostname.replace(/^www\./, "")
  if (own === "" || bare === host || isSiteName(own, host)) return undefined
  const address = publicWebUrl(own)
  return address.kind === PUBLIC_WEB_URL.ok && address.url.href === page.url.href ? undefined : own
}

const isSiteName = (title: string, host: string): boolean => {
  const name = title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")
  return name !== "" && host.split(".").slice(0, -1).includes(name)
}
