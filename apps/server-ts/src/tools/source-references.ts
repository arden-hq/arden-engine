import { DateTime, Effect, Schema } from "effect"
import { accountReadyFor } from "@arden-hq/protocol/google"
import {
  SOURCE_DATE,
  SOURCE_INPUT,
  SOURCE_LINK,
  type SourceLink,
  type SourceMetadata,
  type SourceMetadataInput
} from "@arden-hq/protocol/source-titles"
import { publicWebUrl } from "@arden-hq/std/url"
import type { GoogleToolConnections } from "./google-accounts.js"
import { googleCall, decodeGoogle } from "./google-request.js"
import { GMAIL_REF_KIND, gmailRefKind, parseGmailRef } from "./google-gmail-refs.js"
import { GMAIL_API, message, thread, header, messageDate } from "./google-gmail-mime.js"
import { emailSource } from "./google-gmail-source.js"
import { parseFileRef } from "./google-drive.js"
import { AutomationId } from "../persistence/automations/model.js"
import type { AutomationCatalog } from "../persistence/automations/catalog.js"
import type { RunQueries } from "../persistence/runs/queries.js"
import type { SessionQueries } from "../persistence/sessions/queries.js"
import { automationResource } from "./automation-records.js"
import { chatTarget } from "./call-receipt.js"
import { makeSourceTitles } from "./source-titles.js"
import { currentMillis } from "../runtime/clock.js"

const unlinked: SourceLink = { kind: SOURCE_LINK.unlinked }
const undated = { kind: SOURCE_DATE.undated } as const
const linkTo = (href: string | null | undefined): SourceLink =>
  href === null || href === undefined ? unlinked : { kind: SOURCE_LINK.linked, href }

const DriveMetadata = decodeGoogle(
  Schema.Struct({
    id: Schema.NonEmptyString,
    name: Schema.NonEmptyString,
    webViewLink: Schema.optionalKey(Schema.String)
  }),
  { service: "google_drive", label: "file" }
)

export function makeSourceReferences({
  google,
  automations,
  runs,
  sessions
}: {
  readonly automations?: Pick<AutomationCatalog["Service"], "get">
  readonly runs?: Pick<RunQueries["Service"], "get">
  readonly sessions?: Pick<SessionQueries["Service"], "loadHistoryHeader">
  readonly google: GoogleToolConnections
}): {
  readonly read: (
    sources: ReadonlyArray<SourceMetadataInput>
  ) => Promise<ReadonlyArray<SourceMetadata>>
} {
  const titles = makeSourceTitles()
  const cache = new Map<string, { at: number; value: SourceMetadata }>()
  const pending = new Map<string, Promise<SourceMetadata>>()
  const active = new Set<Promise<SourceMetadata>>()
  const readOne = async (input: SourceMetadataInput): Promise<SourceMetadata> => {
    const place = input.type === SOURCE_INPUT.place ? input : undefined
    const href = place?.link.kind === SOURCE_LINK.linked ? place.link.href : undefined
    const web = publicWebUrl(href ?? input.ref)
    const gmailKind = gmailRefKind(input.ref)
    const mailKind = gmailKind ?? GMAIL_REF_KIND.message
    let provider = place?.provider
    if (provider === undefined) {
      if (gmailKind !== undefined) provider = "gmail"
      else if (web.kind === "ok") provider = "web"
      else provider = "unknown"
    }
    let kind = place?.kind
    if (kind === undefined) {
      if (provider === "gmail") kind = mailKind
      else kind = web.kind === "ok" ? "web_page" : "reference"
    }
    const identity = { ref: input.ref, provider, kind }
    const unavailable = (
      reason: "not_connected" | "not_found" | "unsupported" | "unavailable" | "unnamed"
    ): SourceMetadata => ({ ...identity, status: "unavailable", reason })
    if (place?.title.trim() && provider !== "web")
      return {
        ...identity,
        status: "resolved",
        title: place.title,
        date: undated,
        link: place.link
      }
    const drive =
      provider === "google_drive" ||
      provider === "drive" ||
      (web.kind === "ok" && ["docs.google.com", "drive.google.com"].includes(web.url.hostname))
    let accountKey = ""
    if (provider === "gmail") {
      try {
        const ref = parseGmailRef(mailKind, input.ref)
        const account = google
          .accounts()
          .find(
            (candidate) =>
              candidate.email.toLowerCase() === ref.account.toLowerCase() ||
              candidate.id === ref.account
          )
        if (!account || !accountReadyFor(account, "gmail")) return unavailable("not_connected")
        accountKey = account.id
      } catch {
        return unavailable("unsupported")
      }
    }
    if (drive) {
      try {
        const ref = parseFileRef(input.ref)
        const accounts = google
          .accounts()
          .filter((account) => accountReadyFor(account, "google_drive"))
        const account = accounts.find((entry) => {
          if (ref.accountRef === undefined) return accounts.length === 1
          return (
            entry.id === ref.accountRef ||
            entry.email.toLowerCase() === ref.accountRef.toLowerCase()
          )
        })
        if (account) accountKey = account.id
        else if (web.kind !== "ok") return unavailable("not_connected")
      } catch {
        return unavailable("unsupported")
      }
    }
    const key = JSON.stringify([accountKey, input])
    const cacheable = provider === "gmail" || (drive && accountKey !== "")
    const held = cacheable ? cache.get(key) : undefined
    if (held && currentMillis() - held.at < (held.value.status === "resolved" ? 86400000 : 300000))
      return held.value
    const joined = pending.get(key)
    if (joined) return joined
    if (pending.size >= 64) return unavailable("unavailable")
    const perform = async (): Promise<SourceMetadata> => {
      try {
        if (provider === "arden" && kind === "automation") {
          if (!automations) return unavailable("unsupported")
          const automation = await Effect.runPromise(automations.get(AutomationId.make(input.ref)))
          if (!automation) return unavailable("not_found")
          const link = linkTo(automationResource(automation).href)
          return { ...identity, status: "resolved", title: automation.name, date: undated, link }
        }
        if (provider === "arden" && kind === "run") {
          if (!runs || !sessions) return unavailable("unsupported")
          const run = await Effect.runPromise(runs.get(input.ref))
          if (!run) return unavailable("not_found")
          const session = await Effect.runPromise(sessions.loadHistoryHeader(run.sessionId))
          const title = session?.name ?? "Run"
          const link = linkTo(
            session === null ? null : chatTarget({ ...session, turnId: run.turnId }, title).href
          )
          return {
            ...identity,
            status: "resolved",
            title,
            date: { kind: SOURCE_DATE.dated, at: DateTime.formatIso(run.startedAt) },
            link
          }
        }
        if (provider === "gmail") {
          const isThread = mailKind === GMAIL_REF_KIND.thread
          const ref = parseGmailRef(mailKind, input.ref)
          const url = new URL(
            `${GMAIL_API}/${isThread ? "threads" : "messages"}/${encodeURIComponent(ref.id)}`
          )
          url.searchParams.set("format", "metadata")
          url.searchParams.append("metadataHeaders", "Subject")
          url.searchParams.append("metadataHeaders", "From")
          const response = await googleCall({
            google,
            service: "gmail",
            accountRef: accountKey,
            url: url.href,
            signal: AbortSignal.timeout(5000)
          })
          const item = isThread ? thread(response.value).messages.at(-1) : message(response.value)
          if (!item || (!isThread && item.id !== ref.id) || (isThread && item.threadId !== ref.id))
            return unavailable("not_found")
          const source = emailSource({
            kind: isThread ? "thread" : "message",
            ref: input.ref,
            account: response.account.email,
            threadId: item.threadId,
            subject: header(item.payload, "Subject") ?? "(no subject)",
            from: header(item.payload, "From") ?? "",
            receivedAt: messageDate(item.internalDate),
            use: "found"
          })
          return {
            ...identity,
            status: "resolved",
            title: source.title,
            date: undated,
            link: linkTo(source.href)
          }
        }
        if (drive && accountKey === "") {
          if (web.kind !== "ok") return unavailable("not_connected")
          const title = await titles.read({ url: web.url.href, title: place?.title ?? "" })
          if (title === null) return unavailable("not_connected")
          return {
            ...identity,
            provider: "drive",
            kind: "document",
            status: "resolved",
            title,
            date: undated,
            link: linkTo(input.ref)
          }
        }
        if (drive) {
          const ref = parseFileRef(input.ref)
          const response = await googleCall({
            google,
            service: "google_drive",
            accountRef: accountKey,
            url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(ref.id)}?fields=id,name,webViewLink`,
            signal: AbortSignal.timeout(5000)
          })
          const file = DriveMetadata(response.value)
          if (file.id !== ref.id) return unavailable("not_found")
          return {
            ...identity,
            provider: "drive",
            kind: "document",
            status: "resolved",
            title: file.name,
            date: undated,
            link: linkTo(web.kind === "ok" ? input.ref : file.webViewLink)
          }
        }
        if (web.kind !== "ok") return unavailable("unsupported")
        const title = await titles.read({ url: web.url.href, title: place?.title ?? "" })
        return title === null
          ? unavailable("unnamed")
          : {
              ...identity,
              status: "resolved",
              title,
              date: undated,
              link: linkTo(href ?? input.ref)
            }
      } catch {
        return unavailable("unavailable")
      }
    }
    const run = (async () => {
      while (active.size >= 4) await Promise.race(active)
      const job = perform()
      active.add(job)
      try {
        return await job
      } finally {
        active.delete(job)
      }
    })()
    pending.set(key, run)
    const value = await run
    pending.delete(key)
    if (cacheable) {
      cache.set(key, { at: currentMillis(), value })
      if (cache.size > 512) cache.delete(cache.keys().next().value ?? "")
    }
    return value
  }
  return {
    read: async (sources) =>
      Effect.runPromise(
        Effect.forEach(sources, (source) => Effect.promise(() => readOne(source)), {
          concurrency: 4
        })
      )
  }
}
