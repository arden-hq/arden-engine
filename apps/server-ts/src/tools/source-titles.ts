import { clipLine } from "@arden-hq/std/text"
import { publicWebUrl, webSourceTitle } from "@arden-hq/std/url"
import { fetchPage } from "./web-fetch.js"
import { readHtml } from "./html-content.js"
import { currentMillis } from "../runtime/clock.js"

export const makeSourceTitles = (): {
  readonly read: (input: { readonly url: string; readonly title: string }) => Promise<string | null>
} => {
  const cache = new Map<string, { title: string | null; expires: number }>()
  const pending = new Map<string, Promise<string | null>>()
  const active = new Set<Promise<string | null>>()
  const read = async (input: {
    readonly url: string
    readonly title: string
  }): Promise<string | null> => {
    const page = publicWebUrl(input.url)
    if (page.kind !== "ok") return null
    const own = webSourceTitle(input.title, input.url)
    if (own !== undefined) return own
    const key = page.url.href
    const hit = cache.get(key)
    if (hit !== undefined && hit.expires > currentMillis()) return hit.title
    const joined = pending.get(key)
    if (joined !== undefined) return joined
    if (pending.size >= 32) return null
    const run = (async () => {
      while (active.size >= 4) await Promise.race(active)
      const fetch = fetchPage(page.url, "html", AbortSignal.timeout(5000))
        .then((result) => {
          const mime = result.contentType.split(";", 1)[0]?.trim().toLowerCase()
          if (mime !== "text/html" && mime !== "application/xhtml+xml") return null
          const title = readHtml(result.content, { format: "html" }).title
          const named = title === undefined ? undefined : webSourceTitle(title, input.url)
          return named === undefined ? null : clipLine(named, 256)
        })
        .catch(() => null)
      active.add(fetch)
      const title = await fetch
      active.delete(fetch)
      cache.delete(key)
      cache.set(key, { title, expires: currentMillis() + (title === null ? 300_000 : 86_400_000) })
      if (cache.size > 512) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      pending.delete(key)
      return title
    })()
    pending.set(key, run)
    return run
  }
  return { read }
}
