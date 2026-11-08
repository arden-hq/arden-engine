import { sha256Bytes } from "@arden-hq/std/hash"
import { slugify } from "@arden-hq/std/slug"

const ADJECTIVES = [
  "amber",
  "brave",
  "bright",
  "brisk",
  "calm",
  "clear",
  "clever",
  "cosmic",
  "crisp",
  "eager",
  "gentle",
  "golden",
  "happy",
  "kind",
  "lucid",
  "mellow",
  "nimble",
  "peaceful",
  "quiet",
  "radiant",
  "steady",
  "swift",
  "vivid",
  "wise"
] as const

const ANIMALS = [
  "badger",
  "beaver",
  "bison",
  "crane",
  "dolphin",
  "falcon",
  "finch",
  "fox",
  "gecko",
  "heron",
  "koala",
  "lark",
  "lynx",
  "otter",
  "owl",
  "panda",
  "pigeon",
  "puma",
  "raven",
  "seal",
  "sparrow",
  "tiger",
  "turtle",
  "wolf"
] as const

const digest = (value: string): Buffer => sha256Bytes(value)

const suffix = (value: Buffer): string => {
  const space = 36n ** 6n
  return (value.readBigUInt64BE(0) % space).toString(36).padStart(6, "0")
}

const slug = (value: string): string =>
  slugify(value, { normalize: "nfkd-ascii", max: 56, trimCut: true, fallback: "automation" })

export const namedPublicRef = (name: string, identity: string): string => {
  const value = digest(`${name}\0${identity}`)
  return `${slug(name)}~${suffix(value)}`
}

export const friendlySessionRef = (identity: string): string => {
  const value = digest(`session\0${identity}`)
  const adjective = ADJECTIVES[value.readUInt16BE(8) % ADJECTIVES.length]
  const animal = ANIMALS[value.readUInt16BE(10) % ANIMALS.length]
  return `${adjective}-${animal}~${suffix(value)}`
}
