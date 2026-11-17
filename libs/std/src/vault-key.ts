/**
 * The rules of a key saved in Arden's Vault: what a name and a "Send only to" address may be,
 * the environment variable a command reads it from, and which request an address covers. One
 * implementation for the server (the agent's key tools), the desktop's Vault page and its main
 * process (the key store and the key proxy).
 */

import { isLoopbackHost } from "./url.js"

/**
 * What an agent may suggest on the chat's add-a-key card, and what that card saves: at most 3
 * addresses, each at most 80 characters, so every one is in plain sight on the card.
 */
export const CARD_MAX_ADDRESSES = 3
export const CARD_MAX_ADDRESS_LENGTH = 80

/** Whether a list of addresses fits the add-a-key card's limit. */
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
/** A host name, an IPv4 address, or an IPv6 address in brackets, with an optional port. */
const ADDRESS_PATTERN = new RegExp(
  `^(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9a-f:.]+\\])(?::[1-9][0-9]{0,4})?$`
)

/** A key's name as typed: one line, 1 to 64 characters, at least one letter or digit. */
export function keyName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const name = value.trim().replace(/\s+/g, " ")
  if (name.length < 1 || name.length > MAX_KEY_NAME_LENGTH) return undefined
  if (/[\u0000-\u001f\u007f]/.test(name) || !/[\p{L}\p{N}]/u.test(name)) return undefined
  return name
}

/**
 * The environment variable a command reads the key from: "Todoist" → TODOIST_API_KEY. Accents
 * are dropped and other characters become "_"; a name that already ends in KEY or TOKEN keeps
 * that ending. Two names with the same variable are the same key: the store refuses the second.
 */
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
function addressOf(entry: string): string | undefined {
  const text = entry.trim().toLowerCase()
  if (text.length === 0 || text.length > MAX_ADDRESS_LENGTH || /\s/.test(text)) return undefined
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(text)?.[1]
  if (scheme !== undefined && scheme !== "https" && scheme !== "http") return undefined
  const rest = scheme === undefined ? text : text.slice(scheme.length + 3)
  const authority = rest.split(/[/?#]/, 1)[0] ?? ""
  if (/[?#]/.test(rest) || authority.includes("@")) return undefined
  // "api.todoist.com." names the same host as "api.todoist.com".
  const address = authority.replace(/\.(?=$|:\d+$)/, "")
  if (!ADDRESS_PATTERN.test(address)) return undefined
  const port = portOf(address)
  return port !== undefined && port > 65_535 ? undefined : address
}

export type AddressesRead =
  | { readonly kind: "ok"; readonly addresses: string[] }
  | { readonly kind: "empty" }
  | { readonly kind: "refused"; readonly entry: string }
  | { readonly kind: "too_many" }

/** Every address in a "Send only to" field, split at commas and spaces, without repeats. */
export function readAddresses(text: string): AddressesRead {
  const entries = text.split(/[\s,]+/).filter((entry) => entry.length > 0)
  if (entries.length === 0) return { kind: "empty" }
  const addresses: string[] = []
  for (const entry of entries) {
    const address = addressOf(entry)
    if (address === undefined) return { kind: "refused", entry }
    if (!addresses.includes(address)) addresses.push(address)
  }
  return addresses.length > MAX_KEY_ADDRESSES ? { kind: "too_many" } : { kind: "ok", addresses }
}

/** A stored list as the store accepts it: canonical addresses only, 1 to 16, no repeats. */
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

/**
 * Whether an address is on this machine (localhost, 127.0.0.1, [::1]): any program on it that
 * listens there can receive a key sent to it, so the cards say so.
 */
export function onThisMachine(address: string): boolean {
  return isLoopbackHost(hostOf(address))
}

/**
 * Whether a key bound to `address` may go in a request to `host` on `port`. The host matches
 * exactly (todoist.com does not cover api.todoist.com). An address without a port covers https
 * on 443, and for a host on this machine also http on 80; one with a port covers that port.
 * Plain http to another machine is never covered: the key would cross the network in clear.
 */
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
