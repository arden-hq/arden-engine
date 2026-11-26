export const WIKI_ORIGIN_KIND = {
  user: "user",
  forget: "forget",
  rules: "rules",
  agent: "agent",
  automation: "automation",
  upkeep: "upkeep",
  capture: "capture",
  space_page: "space_page",
  system: "system"
} as const
type WikiOriginKind = (typeof WIKI_ORIGIN_KIND)[keyof typeof WIKI_ORIGIN_KIND]

export const WIKI_USER_VIA = { filesystem: "filesystem", desktop: "desktop" } as const
type DesktopVia = `${typeof WIKI_USER_VIA.desktop}${string}`
type WikiUserVia = typeof WIKI_USER_VIA.filesystem | DesktopVia

const OWNER_TURN_ORIGINS = {
  [WIKI_ORIGIN_KIND.forget]: "memory.forget",
  [WIKI_ORIGIN_KIND.rules]: "memory.rules"
} as const
type OwnerTurnKind = keyof typeof OWNER_TURN_ORIGINS
const OWNER_TURN_KINDS = [WIKI_ORIGIN_KIND.forget, WIKI_ORIGIN_KIND.rules] as const

export type WikiCommitOrigin =
  | {
      readonly kind: typeof WIKI_ORIGIN_KIND.user
      readonly via: WikiUserVia
    }
  | { readonly kind: OwnerTurnKind; readonly sessionId: string }
  | {
      readonly kind: typeof WIKI_ORIGIN_KIND.agent
      readonly sessionId: string | undefined
      readonly chainDepth?: number
    }
  | {
      readonly kind: typeof WIKI_ORIGIN_KIND.automation
      readonly automationId: string
      readonly chainDepth?: number
    }
  | {
      readonly kind: typeof WIKI_ORIGIN_KIND.upkeep
      readonly automationId: string
      readonly chainDepth?: number
    }
  | { readonly kind: typeof WIKI_ORIGIN_KIND.capture; readonly sessionId: string | undefined }
  | { readonly kind: typeof WIKI_ORIGIN_KIND.space_page }
  | { readonly kind: typeof WIKI_ORIGIN_KIND.system; readonly name: string }

export const WIKI_COMMIT_SOURCE = {
  user: "user",
  agent: "agent",
  automation: "automation",
  system: "system"
} as const
export type WikiCommitSource = (typeof WIKI_COMMIT_SOURCE)[keyof typeof WIKI_COMMIT_SOURCE]

export interface WikiCommitIdentity {
  readonly actor: string
  readonly origin: WikiCommitOrigin
  readonly reason: string
  readonly replayKey?: string
}

export const upkeepOrigin = (
  automationId: string,
  chainDepth?: number
): Extract<WikiCommitOrigin, { readonly kind: typeof WIKI_ORIGIN_KIND.upkeep }> => ({
  kind: WIKI_ORIGIN_KIND.upkeep,
  automationId,
  ...(chainDepth === undefined ? {} : { chainDepth })
})

export const automationOrigin = (
  automationId: string,
  chainDepth?: number
): Extract<WikiCommitOrigin, { readonly kind: typeof WIKI_ORIGIN_KIND.automation }> => ({
  kind: WIKI_ORIGIN_KIND.automation,
  automationId,
  ...(chainDepth === undefined ? {} : { chainDepth })
})

export const ownerInApp = (
  reason: string,
  via: DesktopVia = WIKI_USER_VIA.desktop
): WikiCommitIdentity => ({
  actor: "user:desktop",
  origin: { kind: WIKI_ORIGIN_KIND.user, via },
  reason
})

const AUTOMATION_PREFIX = "wiki.automation."
const UPKEEP_PREFIX = "wiki.upkeep."
const RETIRED_UPKEEP_ORIGINS: ReadonlyMap<string, string> = new Map([
  ["wiki.maintenance", "builtin-wiki-maintenance"],
  ["wiki.automation.builtin-wiki-maintenance", "builtin-wiki-maintenance"]
])
const CHAIN_MARK = "~"
const AGENT_ORIGIN = "wiki.agent"
const CAPTURE_ORIGIN = "memory.capture"
const SPACE_PAGE_ORIGIN = "space.page"
const CHAINED = /^(.+)~(\d+)$/u

const chainMark = (chainDepth: number | undefined): string =>
  chainDepth === undefined || chainDepth === 0 ? "" : `${CHAIN_MARK}${chainDepth}`

const withChat = (base: string, sessionId: string | undefined): string =>
  sessionId === undefined ? base : `${base}@${sessionId}`

const chatOf = (origin: string, base: string): string | undefined | null => {
  if (origin === base) return undefined
  return origin.startsWith(`${base}@`) && origin.length > base.length + 1
    ? origin.slice(base.length + 1)
    : null
}

export const encodeWikiOrigin = (origin: WikiCommitOrigin): string => {
  switch (origin.kind) {
    case WIKI_ORIGIN_KIND.user:
      return origin.via
    case WIKI_ORIGIN_KIND.agent:
      return `${withChat(AGENT_ORIGIN, origin.sessionId)}${chainMark(origin.chainDepth)}`
    case WIKI_ORIGIN_KIND.automation:
      return `${AUTOMATION_PREFIX}${origin.automationId}${chainMark(origin.chainDepth)}`
    case WIKI_ORIGIN_KIND.upkeep:
      return `${UPKEEP_PREFIX}${origin.automationId}${chainMark(origin.chainDepth)}`
    case WIKI_ORIGIN_KIND.capture:
      return withChat(CAPTURE_ORIGIN, origin.sessionId)
    case WIKI_ORIGIN_KIND.forget:
    case WIKI_ORIGIN_KIND.rules:
      return withChat(OWNER_TURN_ORIGINS[origin.kind], origin.sessionId)
    case WIKI_ORIGIN_KIND.space_page:
      return SPACE_PAGE_ORIGIN
    case WIKI_ORIGIN_KIND.system:
      return origin.name
  }
}

const isUserVia = (origin: string): origin is WikiUserVia =>
  origin === WIKI_USER_VIA.filesystem || origin.startsWith(WIKI_USER_VIA.desktop)

export const decodeWikiOrigin = (origin: string): WikiCommitOrigin => {
  if (isUserVia(origin)) return { kind: WIKI_ORIGIN_KIND.user, via: origin }
  const agentChained = CHAINED.exec(origin)
  const agentChat = chatOf(agentChained?.[1] ?? origin, AGENT_ORIGIN)
  if (agentChat !== null)
    return {
      kind: WIKI_ORIGIN_KIND.agent,
      sessionId: agentChat,
      ...(agentChained?.[2] === undefined ? {} : { chainDepth: Number(agentChained[2]) })
    }
  const captureChat = chatOf(origin, CAPTURE_ORIGIN)
  if (captureChat !== null) return { kind: WIKI_ORIGIN_KIND.capture, sessionId: captureChat }
  for (const kind of OWNER_TURN_KINDS) {
    const ownerChat = chatOf(origin, OWNER_TURN_ORIGINS[kind])
    if (ownerChat !== null && ownerChat !== undefined) return { kind, sessionId: ownerChat }
  }
  if (origin === SPACE_PAGE_ORIGIN) return { kind: WIKI_ORIGIN_KIND.space_page }
  const prefix = [UPKEEP_PREFIX, AUTOMATION_PREFIX].find((each) => origin.startsWith(each))
  const named = prefix === undefined ? "" : origin.slice(prefix.length).trim()
  const chained = CHAINED.exec(named)
  const automationId = chained?.[1] ?? named
  const retired = RETIRED_UPKEEP_ORIGINS.get(
    automationId === "" ? origin : `${prefix ?? ""}${automationId}`
  )
  if (automationId === "" && retired === undefined)
    return { kind: WIKI_ORIGIN_KIND.system, name: origin }
  const chainDepth = chained?.[2] === undefined ? undefined : Number(chained[2])
  return prefix === UPKEEP_PREFIX || retired !== undefined
    ? upkeepOrigin(retired ?? automationId, chainDepth)
    : automationOrigin(automationId, chainDepth)
}

const SOURCE_OF_ORIGIN: Readonly<Record<WikiOriginKind, WikiCommitSource>> = {
  user: WIKI_COMMIT_SOURCE.user,
  forget: WIKI_COMMIT_SOURCE.user,
  rules: WIKI_COMMIT_SOURCE.user,
  agent: WIKI_COMMIT_SOURCE.agent,
  automation: WIKI_COMMIT_SOURCE.automation,
  capture: WIKI_COMMIT_SOURCE.automation,
  upkeep: WIKI_COMMIT_SOURCE.automation,
  space_page: WIKI_COMMIT_SOURCE.system,
  system: WIKI_COMMIT_SOURCE.system
}

export const wikiOriginSource = (origin: WikiCommitOrigin): WikiCommitSource =>
  SOURCE_OF_ORIGIN[origin.kind]

export const wikiOriginChat = (origin: WikiCommitOrigin): string | undefined => {
  switch (origin.kind) {
    case WIKI_ORIGIN_KIND.agent:
    case WIKI_ORIGIN_KIND.capture:
    case WIKI_ORIGIN_KIND.forget:
    case WIKI_ORIGIN_KIND.rules:
      return origin.sessionId
    case WIKI_ORIGIN_KIND.user:
    case WIKI_ORIGIN_KIND.automation:
    case WIKI_ORIGIN_KIND.upkeep:
    case WIKI_ORIGIN_KIND.space_page:
    case WIKI_ORIGIN_KIND.system:
      return undefined
  }
}

export const isAutomatedOrigin = (origin: WikiCommitOrigin): boolean =>
  wikiOriginSource(origin) === WIKI_COMMIT_SOURCE.automation

const OWNER_ORIGINS: ReadonlySet<WikiOriginKind> = new Set([
  WIKI_ORIGIN_KIND.user,
  WIKI_ORIGIN_KIND.forget,
  WIKI_ORIGIN_KIND.rules
])

export const isOwnerOrigin = (origin: WikiCommitOrigin): boolean => OWNER_ORIGINS.has(origin.kind)

export const isCaptureWriter = (origin: WikiCommitOrigin): boolean =>
  origin.kind === WIKI_ORIGIN_KIND.capture

export const isSpacePageWriter = (origin: WikiCommitOrigin): boolean =>
  origin.kind === WIKI_ORIGIN_KIND.space_page

export const isOutsideEdit = (origin: WikiCommitOrigin): boolean =>
  origin.kind === WIKI_ORIGIN_KIND.user && origin.via === WIKI_USER_VIA.filesystem

export const isUpkeep = (origin: WikiCommitOrigin): boolean =>
  origin.kind === WIKI_ORIGIN_KIND.upkeep

export const isProducer = (origin: WikiCommitOrigin, producer: string): boolean =>
  origin.kind === WIKI_ORIGIN_KIND.automation && origin.automationId === producer
