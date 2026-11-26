export const MANAGED_OBJECT_HASH = /^[a-f0-9]{64}$/u
const MANAGED_OBJECT_PREFIX = "arden:managed-output/"

export const MANAGED_OBJECT_FORMAT = { text: "text", json: "json" } as const
const MANAGED_OBJECT_FORMATS = Object.values(MANAGED_OBJECT_FORMAT)
export type ManagedObjectFormat = (typeof MANAGED_OBJECT_FORMAT)[keyof typeof MANAGED_OBJECT_FORMAT]

export const isManagedObjectFormat = (value: unknown): value is ManagedObjectFormat =>
  MANAGED_OBJECT_FORMATS.some((format) => format === value)

export interface ManagedObjectAddress {
  readonly owner: string
  readonly digest: string
  readonly format: ManagedObjectFormat
}

export const MANAGED_REF_KIND = {
  managed: "managed",
  malformed: "malformed",
  other: "other"
} as const

export type ManagedObjectRef =
  | ({ readonly kind: typeof MANAGED_REF_KIND.managed } & ManagedObjectAddress)
  | { readonly kind: typeof MANAGED_REF_KIND.malformed }
  | { readonly kind: typeof MANAGED_REF_KIND.other }

export const managedObjectRef = (address: ManagedObjectAddress): string =>
  `${MANAGED_OBJECT_PREFIX}${address.owner}/${address.digest}/${address.format}`

export const readManagedObjectRef = (ref: string): ManagedObjectRef => {
  if (!ref.startsWith(MANAGED_OBJECT_PREFIX)) return { kind: MANAGED_REF_KIND.other }
  const segments = ref.slice(MANAGED_OBJECT_PREFIX.length).split("/")
  if (segments.length !== 3) return { kind: MANAGED_REF_KIND.malformed }
  const [owner, digest, format] = segments
  if (
    owner === undefined ||
    digest === undefined ||
    !MANAGED_OBJECT_HASH.test(owner) ||
    !MANAGED_OBJECT_HASH.test(digest) ||
    !isManagedObjectFormat(format)
  )
    return { kind: MANAGED_REF_KIND.malformed }
  return { kind: MANAGED_REF_KIND.managed, owner, digest, format }
}
