import { isSecureServerUrl } from "@arden-hq/std/url"

export const normalizeServerUrl = (raw: string): string | undefined => {
  const trimmed = raw.trim()
  if (!isSecureServerUrl(trimmed)) return undefined
  const url = new URL(trimmed)
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")
  return `${url.protocol}//${url.host}${path}${url.search}`
}

export type OfferCandidate =
  | { readonly kind: "preset"; readonly id: string; readonly title: string }
  | { readonly kind: "url"; readonly url: string; readonly title: string }

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
    candidate.kind === "preset"
      ? server.presetId === candidate.id
      : address !== undefined && normalizeServerUrl(candidate.url) === address
  )
}
