import type { MobileLetter, MobileLink } from "@arden-hq/protocol/mobile"
import type { HomeLetter } from "@arden-hq/protocol/runs"

export type ArdenPlace =
  | { readonly kind: "session_ref"; readonly ref: string }
  | { readonly kind: "space"; readonly id: string }
  | { readonly kind: "task"; readonly id: string }

export function ardenPlace(href: string): ArdenPlace | undefined {
  const address = /^arden:(session|space|task|work)\/([^/?#]+)(\/[^?#]+)?/.exec(href)
  if (address === null) return undefined
  if (address[3] !== undefined && (address[1] === "task" || address[1] === "work")) return undefined
  const id = safeDecode(address[2] ?? "")
  if (id === undefined || id === "") return undefined
  if (address[1] === "session") return { kind: "session_ref", ref: id }
  return address[1] === "space" ? { kind: "space", id } : { kind: "task", id }
}

function letterPlace(
  href: string | null | undefined
): ArdenPlace | { readonly kind: "url"; readonly id: string } | undefined {
  if (href === null || href === undefined) return undefined
  if (/^https?:/i.test(href)) return { kind: "url", id: href }
  return ardenPlace(href)
}

export interface PhonePlaces {
  readonly sessionIds: ReadonlyMap<string, string>
  readonly taskPlaces: ReadonlyMap<string, PhoneHome>
}

export interface PhoneHome {
  readonly kind: "session" | "space"
  readonly id: string
}

export function placeHome(place: ArdenPlace, resolved: PhonePlaces): PhoneHome | undefined {
  switch (place.kind) {
    case "session_ref": {
      const id = resolved.sessionIds.get(place.ref)
      return id === undefined ? undefined : { kind: "session", id }
    }
    case "space":
      return place
    case "task":
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
  if (place?.kind === "session_ref") keys.refs.add(place.ref)
  if (place?.kind === "task") keys.taskIds.add(place.id)
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
  const linkOf = (href: string | null | undefined): MobileLink | null => {
    const place = letterPlace(href)
    if (place === undefined) return null
    if (place.kind === "url") return place
    return placeHome(place, resolved) ?? null
  }
  return {
    run_id: letter.run_id,
    generated_at: letter.generated_at,
    paragraphs: letter.body.paragraphs.map((paragraph) =>
      paragraph.map((segment) => ({ text: segment.text, link: linkOf(segment.href) }))
    )
  }
}

const safeDecode = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}
