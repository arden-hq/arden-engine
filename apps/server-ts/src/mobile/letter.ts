import { type HomeLetter } from "../persistence/home/letter-schema.js"
import { MOBILE_LINK, type MobileLetter, type MobileLink } from "@arden-hq/protocol/mobile"

const ARDEN_PLACE = { sessionRef: "session_ref", space: "space", task: "task" } as const

export type ArdenPlace =
  | { readonly kind: typeof ARDEN_PLACE.sessionRef; readonly ref: string }
  | { readonly kind: typeof ARDEN_PLACE.space; readonly id: string }
  | { readonly kind: typeof ARDEN_PLACE.task; readonly id: string }

const ARDEN_ADDRESS = { session: "session", space: "space", task: "task", work: "work" } as const

type ArdenAddress = (typeof ARDEN_ADDRESS)[keyof typeof ARDEN_ADDRESS]

const ADDRESS_PLACE: Record<ArdenAddress, (id: string) => ArdenPlace> = {
  [ARDEN_ADDRESS.session]: (ref) => ({ kind: ARDEN_PLACE.sessionRef, ref }),
  [ARDEN_ADDRESS.space]: (id) => ({ kind: ARDEN_PLACE.space, id }),
  [ARDEN_ADDRESS.task]: (id) => ({ kind: ARDEN_PLACE.task, id }),
  [ARDEN_ADDRESS.work]: (id) => ({ kind: ARDEN_PLACE.task, id })
}

const ADDRESS_WITHOUT_TAIL: ReadonlySet<ArdenAddress> = new Set([
  ARDEN_ADDRESS.task,
  ARDEN_ADDRESS.work
])

const ARDEN_ADDRESSES: ReadonlySet<string> = new Set<ArdenAddress>(Object.values(ARDEN_ADDRESS))

const isArdenAddress = (value: string | undefined): value is ArdenAddress =>
  value !== undefined && ARDEN_ADDRESSES.has(value)

export function ardenPlace(href: string): ArdenPlace | undefined {
  const address = /^arden:(session|space|task|work)\/([^/?#]+)(\/[^?#]+)?/.exec(href)
  if (address === null) return undefined
  const kind = address[1]
  if (!isArdenAddress(kind)) return undefined
  if (address[3] !== undefined && ADDRESS_WITHOUT_TAIL.has(kind)) return undefined
  const id = safeDecode(address[2] ?? "")
  if (id === undefined || id === "") return undefined
  return ADDRESS_PLACE[kind](id)
}

function letterPlace(
  href: string | null | undefined
): ArdenPlace | { readonly kind: typeof MOBILE_LINK.url; readonly id: string } | undefined {
  if (href === null || href === undefined) return undefined
  if (/^https?:/i.test(href)) return { kind: MOBILE_LINK.url, id: href }
  return ardenPlace(href)
}

export interface PhonePlaces {
  readonly sessionIds: ReadonlyMap<string, string>
  readonly taskPlaces: ReadonlyMap<string, PhoneHome>
}

export interface PhoneHome {
  readonly kind: typeof MOBILE_LINK.session | typeof MOBILE_LINK.space
  readonly id: string
}

export function placeHome(place: ArdenPlace, resolved: PhonePlaces): PhoneHome | undefined {
  switch (place.kind) {
    case ARDEN_PLACE.sessionRef: {
      const id = resolved.sessionIds.get(place.ref)
      return id === undefined ? undefined : { kind: MOBILE_LINK.session, id }
    }
    case ARDEN_PLACE.space:
      return place
    case ARDEN_PLACE.task:
      return resolved.taskPlaces.get(place.id)
  }
}

export interface LinkKeys {
  readonly refs: Set<string>
  readonly taskIds: Set<string>
}

export const newLinkKeys = (): LinkKeys => ({ refs: new Set(), taskIds: new Set() })

export function addLinkKeys(keys: LinkKeys, href: string | null | undefined): void {
  const place = href === null || href === undefined ? undefined : ardenPlace(href)
  if (place?.kind === ARDEN_PLACE.sessionRef) keys.refs.add(place.ref)
  if (place?.kind === ARDEN_PLACE.task) keys.taskIds.add(place.id)
}

export function letterLookupKeys(letter: HomeLetter): {
  readonly refs: string[]
  readonly taskIds: string[]
} {
  const keys = newLinkKeys()
  for (const paragraph of letter.body.paragraphs)
    for (const segment of paragraph) addLinkKeys(keys, segment.href)
  return { refs: [...keys.refs], taskIds: [...keys.taskIds] }
}

export function mobileLetter(letter: HomeLetter, resolved: PhonePlaces): MobileLetter {
  const linkOf = (href: string | null | undefined): MobileLink | undefined => {
    const place = letterPlace(href)
    if (place === undefined) return undefined
    if (place.kind === MOBILE_LINK.url) return place
    return placeHome(place, resolved)
  }
  const segmentOf = (segment: { readonly text: string; readonly href?: string | null }) => {
    const link = linkOf(segment.href)
    return link === undefined
      ? { kind: "text" as const, text: segment.text }
      : { kind: "link" as const, text: segment.text, link }
  }
  return {
    run_id: letter.run_id,
    generated_at: letter.generated_at,
    paragraphs: letter.body.paragraphs.map((paragraph) => paragraph.map(segmentOf))
  }
}

const safeDecode = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}
