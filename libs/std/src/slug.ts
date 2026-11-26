export const SLUG_NORMALIZE = { nfkd: "nfkd", nfkdAscii: "nfkd-ascii" } as const

export type SlugNormalize = (typeof SLUG_NORMALIZE)[keyof typeof SLUG_NORMALIZE]

export interface SlugOptions {
  readonly separator?: "-" | "_"
  readonly max?: number
  readonly trimCut?: boolean
  readonly fallback?: string
  readonly normalize?: SlugNormalize
  readonly lowerFirst?: boolean
}

export const slugify = (text: string, options: SlugOptions = {}): string => {
  const {
    separator = "-",
    max,
    trimCut = false,
    fallback = "",
    normalize,
    lowerFirst = false
  } = options
  let value = lowerFirst ? text.toLowerCase() : text
  if (normalize !== undefined) value = value.normalize("NFKD")
  if (normalize === SLUG_NORMALIZE.nfkdAscii) value = value.replace(/[^\x00-\x7F]/g, "")
  if (!lowerFirst) value = value.toLowerCase()
  value = value
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^${separator}+|${separator}+$`, "g"), "")
  if (max !== undefined) value = value.slice(0, max)
  if (trimCut) value = value.replace(new RegExp(`${separator}+$`), "")
  return value === "" ? fallback : value
}

export const uniqueName = (
  base: string,
  taken: ReadonlySet<string>,
  separator: "-" | "_" = "-"
): string => {
  if (!taken.has(base)) return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base}${separator}${index}`
    if (!taken.has(candidate)) return candidate
  }
}
