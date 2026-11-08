const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])

/**
 * The host names this machine: `localhost`, `127.0.0.1` or `::1`, bare (a
 * `Host` header without its port) or bracketed (`URL.hostname`). Exact
 * spelling only: `localhost.`, `127.0.0.2` and `LOCALHOST` are other hosts.
 */
export const isLoopbackHost = (host: string): boolean =>
  LOOPBACK_HOSTS.has(host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host)

/** Why an address is not one Arden may connect to as a server. */
export type ServerUrlIssue = "invalid" | "credentials" | "fragment" | "insecure"

/**
 * Why `raw` is not a server address Arden may connect to, or undefined when it
 * is one: an absolute URL with no user name, password or fragment, over https,
 * or over http to this machine (`isLoopbackHost`). `http: "never"` takes https
 * alone. A page's origin is checked by passing `url.origin`.
 */
export const serverUrlIssue = (
  raw: string,
  { http = "loopback" }: { readonly http?: "loopback" | "never" } = {}
): ServerUrlIssue | undefined => {
  if (!URL.canParse(raw)) return "invalid"
  const url = new URL(raw)
  if (url.username !== "" || url.password !== "") return "credentials"
  if (url.hash !== "") return "fragment"
  if (url.protocol === "https:") return undefined
  return url.protocol === "http:" && http === "loopback" && isLoopbackHost(url.hostname)
    ? undefined
    : "insecure"
}

export const isSecureServerUrl = (
  raw: string,
  options?: { readonly http?: "loopback" | "never" }
): boolean => serverUrlIssue(raw, options) === undefined

const MAX_WEB_URL = 4_096

/** Why an address is not a web page a tool may fetch or show. */
export type WebUrlIssue = "invalid" | "scheme" | "credentials" | "too_long"

export type PublicWebUrl =
  | { readonly kind: "ok"; readonly url: URL }
  | { readonly kind: "refused"; readonly issue: WebUrlIssue }

/**
 * A web page a tool may fetch or show: http or https, no user name or
 * password, at most 4,096 characters as given and as parsed (fragment
 * included), returned with its fragment dropped. `raw` may be relative to
 * `base`. Whether its host resolves to a public address is the fetcher's own
 * check (web_fetch).
 */
export const publicWebUrl = (raw: string, base?: string | URL): PublicWebUrl => {
  if (!URL.canParse(raw, base?.toString())) return refused("invalid")
  const url = new URL(raw, base)
  if (url.protocol !== "http:" && url.protocol !== "https:") return refused("scheme")
  if (url.username !== "" || url.password !== "") return refused("credentials")
  if (raw.length > MAX_WEB_URL || url.href.length > MAX_WEB_URL) return refused("too_long")
  url.hash = ""
  return { kind: "ok", url }
}

export const isPublicWebUrl = (raw: string): boolean => publicWebUrl(raw).kind === "ok"

const refused = (issue: WebUrlIssue): PublicWebUrl => ({ kind: "refused", issue })

/** A source title is absent when a provider filled in only its address, its
 *  host, or the site's own name: a page that hides itself from a fetcher still
 *  says "Reddit", and that names every page of the site alike. */
export const webSourceTitle = (title: string, url: string): string | undefined => {
  const page = publicWebUrl(url)
  if (page.kind !== "ok") return undefined
  const own = title.trim()
  const bare = own.toLowerCase().replace(/^www\./, "")
  const host = page.url.hostname.replace(/^www\./, "")
  if (own === "" || bare === host || isSiteName(own, host)) return undefined
  const address = publicWebUrl(own)
  return address.kind === "ok" && address.url.href === page.url.href ? undefined : own
}

const isSiteName = (title: string, host: string): boolean => {
  const name = title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")
  return name !== "" && host.split(".").slice(0, -1).includes(name)
}
