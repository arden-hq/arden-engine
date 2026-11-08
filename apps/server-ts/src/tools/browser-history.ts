import { ToolExecutionError } from "@arden-hq/loop"
import { copyFile, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { makeSqliteThreadClient } from "@arden-hq/sqlite-thread"
import { publicWebUrl } from "@arden-hq/std/url"
import { Effect, Schema } from "effect"
import { Reactivity } from "effect/unstable/reactivity"

import { defineServerTool, type ServerTool } from "./define.js"
import { currentMillis } from "../runtime/clock.js"

const WINDOW_DAYS = 90
const MIN_VISITS = 10
const MIN_DAYS = 2
const MAX_DOMAINS = 40
const MAX_PATHS = 3
const MIN_PATH_VISITS = 3
const DAY_MS = 86_400_000
/** Chromium stores times as microseconds since 1601-01-01 UTC. */
const CHROMIUM_EPOCH_OFFSET_MS = 11_644_473_600_000

const BROWSERS: ReadonlyArray<{ readonly name: string; readonly root: string }> = [
  { name: "Chrome", root: "Google/Chrome" },
  { name: "Arc", root: "Arc/User Data" },
  { name: "Brave", root: "BraveSoftware/Brave-Browser" },
  { name: "Edge", root: "Microsoft Edge" },
  { name: "Chromium", root: "Chromium" },
  { name: "Helium", root: "net.imput.helium" }
]

const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu"])

const SEARCH_HOSTS = new Set([
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "search.yahoo.com",
  "yandex.ru",
  "yandex.com",
  "baidu.com",
  "search.brave.com",
  "kagi.com",
  "ecosia.org"
])
const SEARCH_SECTIONS = new Set(["", "search", "webhp", "url", "html"])

const PLAIN_SECTION = /^[a-z][a-z-]{0,23}$/

interface HistoryVisit {
  readonly url: string
  readonly at: number
}

interface HistoryDomain {
  readonly domain: string
  readonly visits: number
  readonly days: number
  readonly paths: ReadonlyArray<string>
}

const summarizeHistory = (
  visits: ReadonlyArray<HistoryVisit>,
  { since }: { readonly since: number }
): ReadonlyArray<HistoryDomain> => {
  const domains = new Map<
    string,
    { visits: number; days: Set<number>; paths: Map<string, number> }
  >()
  for (const visit of visits) {
    if (visit.at < since) continue
    const place = webPlace(visit.url)
    if (place === undefined) continue
    const entry = domains.get(place.domain) ?? { visits: 0, days: new Set(), paths: new Map() }
    entry.visits += 1
    entry.days.add(Math.floor(visit.at / DAY_MS))
    if (place.section !== undefined) {
      const path = `${place.host}/${place.section}`
      entry.paths.set(path, (entry.paths.get(path) ?? 0) + 1)
    }
    domains.set(place.domain, entry)
  }
  return [...domains]
    .filter(([, entry]) => entry.visits >= MIN_VISITS && entry.days.size >= MIN_DAYS)
    .sort(([leftDomain, left], [rightDomain, right]) =>
      left.visits === right.visits
        ? leftDomain.localeCompare(rightDomain)
        : right.visits - left.visits
    )
    .slice(0, MAX_DOMAINS)
    .map(([domain, entry]) => ({
      domain,
      visits: entry.visits,
      days: entry.days.size,
      paths: [...entry.paths]
        .filter(([, count]) => count >= MIN_PATH_VISITS)
        .sort(([leftPath, left], [rightPath, right]) =>
          left === right ? leftPath.localeCompare(rightPath) : right - left
        )
        .slice(0, MAX_PATHS)
        .map(([path]) => path)
    }))
}

const webPlace = (
  raw: string
):
  | { readonly domain: string; readonly host: string; readonly section: string | undefined }
  | undefined => {
  const page = publicWebUrl(raw)
  if (page.kind === "refused") return undefined
  const url = page.url
  const host = url.hostname.toLowerCase().replace(/^www\./, "")
  const labels = host.split(".")
  if (labels.length < 2 || labels.every((label) => /^\d+$/.test(label)) || host.includes(":"))
    return undefined
  const secondLevel = labels.at(-2) ?? ""
  const domain = labels
    .slice(SECOND_LEVEL.has(secondLevel) && labels.length > 2 ? -3 : -2)
    .join(".")
  const first = url.pathname.split("/")[1]?.toLowerCase() ?? ""
  if (SEARCH_HOSTS.has(host) && SEARCH_SECTIONS.has(first)) return undefined
  return { domain, host, section: PLAIN_SECTION.test(first) ? first : undefined }
}

interface ProfileHistory {
  readonly browser: string
  readonly profile: string
  readonly file: string
}

const findProfiles = async (home: string): Promise<ReadonlyArray<ProfileHistory>> => {
  const found = await Promise.all(
    BROWSERS.map(async (browser) => {
      const root = join(home, "Library", "Application Support", browser.root)
      const entries = await readdir(root).catch(() => [])
      const profiles = entries.filter((name) => name === "Default" || /^Profile \d+$/.test(name))
      const present = await Promise.all(
        profiles.map(async (profile) => {
          const file = join(root, profile, "History")
          const info = await stat(file).catch(() => undefined)
          return info?.isFile() === true ? [{ browser: browser.name, profile, file }] : []
        })
      )
      return present.flat()
    })
  )
  return found.flat()
}

/** A running browser locks its History file, so each is read from a private copy. */
const readProfileVisits = async (
  profile: ProfileHistory,
  since: number
): Promise<ReadonlyArray<HistoryVisit>> => {
  const directory = await mkdtemp(join(tmpdir(), "arden-history-"))
  try {
    const copy = join(directory, "History")
    await copyFile(profile.file, copy)
    const rows = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(
          makeSqliteThreadClient({ filename: copy, readonly: true, disableWAL: true }),
          (sql) =>
            // Chromium times pass 2^53, so they are bound as BigInt and read back in milliseconds.
            sql.unsafe<Record<string, unknown>>(
              `SELECT u.url AS url, v.visit_time / 1000 AS visit_ms
               FROM visits v JOIN urls u ON u.id = v.url
               WHERE v.visit_time >= ?`,
              [BigInt(Math.floor(since) + CHROMIUM_EPOCH_OFFSET_MS) * 1000n]
            )
        )
      ).pipe(Effect.provide(Reactivity.layer))
    )
    return rows.flatMap((row) =>
      typeof row["url"] === "string" && typeof row["visit_ms"] === "number"
        ? [{ url: row["url"], at: row["visit_ms"] - CHROMIUM_EPOCH_OFFSET_MS }]
        : []
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const readBrowserHistory = async ({
  home,
  since
}: {
  readonly home: string
  readonly since: number
}): Promise<{
  readonly found: number
  readonly browsers: ReadonlyArray<{ readonly name: string; readonly profiles: number }>
  readonly visits: ReadonlyArray<HistoryVisit>
}> => {
  const profiles = await findProfiles(home)
  const read = await Promise.all(
    profiles.map((profile) =>
      readProfileVisits(profile, since).then(
        (visits) => [{ profile, visits }],
        () => []
      )
    )
  )
  const readable = read.flat()
  return {
    found: profiles.length,
    browsers: [...new Set(readable.map((entry) => entry.profile.browser))].map((name) => ({
      name,
      profiles: readable.filter((entry) => entry.profile.browser === name).length
    })),
    visits: readable.flatMap((entry) => entry.visits)
  }
}

const EmptyParametersSchema = Schema.Record(Schema.String, Schema.Never)

export const makeBrowserHistorySummaryTool = ({
  home = homedir()
}: {
  readonly home?: string
} = {}): ServerTool =>
  defineServerTool({
    name: "browser_history_summary",
    description: [
      "Summarize which websites the user visits most, from the History of every Chromium-family browser on this Mac (Chrome, Arc, Brave, Edge, Chromium, Helium).",
      `Returns up to ${MAX_DOMAINS} domains visited at least ${MIN_VISITS} times on ${MIN_DAYS} or more days in the last ${WINDOW_DAYS} days, with visit counts and up to ${MAX_PATHS} recurring sections each; never page titles or full URLs.`,
      "This is the user's private browsing: call it only after the user agreed to it in this chat, and say you are reading it first."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(EmptyParametersSchema),
    metadata: {
      effect: "none",
      background: true,
      display_name: "Browser History Summary",
      kind: "tool",
      action: "read",
      approval_preview: "Read which sites you visit most (names and counts only).",
      source: "_local",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async () => {
      const since = currentMillis() - WINDOW_DAYS * DAY_MS
      const history = await readBrowserHistory({ home, since })
      if (history.found > 0 && history.browsers.length === 0) {
        throw new ToolExecutionError(
          "Browser history was found but could not be read. Continue without it and ask the user what they do instead.",
          { preview: "History unreadable", retryable: false }
        )
      }
      const browsers = history.browsers
      const domains = summarizeHistory(history.visits, { since })
      return {
        result:
          domains.length === 0
            ? "No browser history with regularly visited sites was found. Ask the user what they do instead."
            : [
                `Most visited sites in the last ${WINDOW_DAYS} days (${browsers.map((browser) => browser.name).join(", ")}):`,
                ...domains.map(
                  (domain) =>
                    `- ${domain.domain}: ${domain.visits} visits on ${domain.days} days${
                      domain.paths.length === 0 ? "" : ` (${domain.paths.join(", ")})`
                    }`
                )
              ].join("\n"),
        preview:
          domains.length === 0 ? "No regular sites found" : `${domains.length} sites you use often`,
        data: { window_days: WINDOW_DAYS, browsers, domains }
      }
    }
  })
