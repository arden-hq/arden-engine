import { isLoopbackHost, isWebProtocol } from "./url.js"

export const CARD_MAX_ADDRESSES = 3
export const CARD_MAX_ADDRESS_LENGTH = 80

export function fitsCard(addresses: ReadonlyArray<string>): boolean {
  return (
    addresses.length >= 1 &&
    addresses.length <= CARD_MAX_ADDRESSES &&
    addresses.every((address) => address.length <= CARD_MAX_ADDRESS_LENGTH)
  )
}

const MAX_KEY_NAME_LENGTH = 64
const MAX_KEY_ADDRESSES = 16
const MAX_ADDRESS_LENGTH = 260
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
const ADDRESS_PATTERN = new RegExp(
  `^(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9a-f:.]+\\])(?::[1-9][0-9]{0,4})?$`
)

export function keyName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const name = value.trim().replace(/\s+/g, " ")
  if (name.length < 1 || name.length > MAX_KEY_NAME_LENGTH) return undefined
  if (/[\u0000-\u001f\u007f]/.test(name) || !/[\p{L}\p{N}]/u.test(name)) return undefined
  return name
}

export function variableOf(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  const stem = stemOf(base)
  return /(?:^|_)(?:KEY|TOKEN)$/.test(stem) ? stem : `${stem}_API_KEY`
}

function stemOf(base: string): string {
  if (base.length === 0) return "VAULT"
  return /^[0-9]/.test(base) ? `KEY_${base}` : base
}

/**
 * One "Send only to" entry as typed ("api.todoist.com", "https://api.todoist.com/v1",
 * "localhost:11434") as the address the key is bound to: the host in lower case, and the port
 * when one was given. A path is dropped; a user name, a query or another scheme is refused.
 */
const withoutRootDot = (authority: string): string => authority.replace(/\.(?=$|:\d+$)/, "")

function addressOf(entry: string): string | undefined {
  const text = entry.trim().toLowerCase()
  if (text.length === 0 || text.length > MAX_ADDRESS_LENGTH || /\s/.test(text)) return undefined
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(text)?.[1]
  if (scheme !== undefined && !isWebProtocol(`${scheme}:`)) return undefined
  const rest = scheme === undefined ? text : text.slice(scheme.length + 3)
  const authority = rest.split(/[/?#]/, 1)[0] ?? ""
  if (/[?#]/.test(rest) || authority.includes("@")) return undefined
  const address = withoutRootDot(authority)
  if (!ADDRESS_PATTERN.test(address)) return undefined
  const port = portOf(address)
  return port !== undefined && port > 65_535 ? undefined : address
}

export const ADDRESSES_READ = {
  ok: "ok",
  empty: "empty",
  refused: "refused",
  too_many: "too_many"
} as const

export type AddressesRead =
  | { readonly kind: typeof ADDRESSES_READ.ok; readonly addresses: string[] }
  | { readonly kind: typeof ADDRESSES_READ.empty }
  | { readonly kind: typeof ADDRESSES_READ.refused; readonly entry: string }
  | { readonly kind: typeof ADDRESSES_READ.too_many }

export function readAddresses(text: string): AddressesRead {
  const entries = text.split(/[\s,]+/).filter((entry) => entry.length > 0)
  if (entries.length === 0) return { kind: ADDRESSES_READ.empty }
  const addresses: string[] = []
  for (const entry of entries) {
    const address = addressOf(entry)
    if (address === undefined) return { kind: ADDRESSES_READ.refused, entry }
    if (!addresses.includes(address)) addresses.push(address)
  }
  return addresses.length > MAX_KEY_ADDRESSES
    ? { kind: ADDRESSES_READ.too_many }
    : { kind: ADDRESSES_READ.ok, addresses }
}

export function storedAddresses(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_KEY_ADDRESSES)
    return undefined
  const entries: string[] = value.filter((entry): entry is string => typeof entry === "string")
  if (entries.length !== value.length || entries.some((entry) => addressOf(entry) !== entry))
    return undefined
  return new Set(entries).size === entries.length ? entries : undefined
}

function hostOf(address: string): string {
  if (address.startsWith("[")) return address.slice(0, address.indexOf("]") + 1)
  const colon = address.lastIndexOf(":")
  return colon < 0 ? address : address.slice(0, colon)
}

function portOf(address: string): number | undefined {
  const tail = address.startsWith("[") ? address.slice(address.indexOf("]")) : address
  const match = /:(\d+)$/.exec(tail)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

export function onThisMachine(address: string): boolean {
  return isLoopbackHost(hostOf(address))
}

export function addressCovers(
  address: string,
  request: { readonly host: string; readonly port: number; readonly secure: boolean }
): boolean {
  const host = request.host.toLowerCase().replace(/\.$/, "")
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  if (hostOf(address) !== bracketed) return false
  if (!request.secure && !isLoopbackHost(bracketed)) return false
  const port = portOf(address)
  if (port !== undefined) return port === request.port
  return request.port === (request.secure ? 443 : 80)
}
