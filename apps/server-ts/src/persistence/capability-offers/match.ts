import { isSecureServerUrl } from "@arden-hq/std/url"

export const normalizeServerUrl = (raw: string): string | undefined => {
  const trimmed = raw.trim()
  if (!isSecureServerUrl(trimmed)) return undefined
  const url = new URL(trimmed)
  const path = url.pathname.replace(/\/+$/, "")
  return `${url.protocol}//${url.host}${path}${url.search}`
}

const OFFER_CANDIDATE = { preset: "preset", url: "url" } as const

export type OfferCandidate =
  | { readonly kind: typeof OFFER_CANDIDATE.preset; readonly id: string; readonly title: string }
  | { readonly kind: typeof OFFER_CANDIDATE.url; readonly url: string; readonly title: string }

export interface ConnectedServer {
  readonly presetId: string | undefined
  readonly url: string | undefined
}

export const candidateConnected = (
  candidates: ReadonlyArray<OfferCandidate>,
  server: ConnectedServer
): OfferCandidate | undefined => {
  const address = server.url === undefined ? undefined : normalizeServerUrl(server.url)
  return candidates.find((candidate) =>
    candidate.kind === OFFER_CANDIDATE.preset
      ? server.presetId === candidate.id
      : address !== undefined && normalizeServerUrl(candidate.url) === address
  )
}
