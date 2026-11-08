export interface SlugOptions {
  /** Joins the words. Default `-`. */
  readonly separator?: "-" | "_"
  /** Cut the slug to this many characters. Default: no cut. */
  readonly max?: number
  /** Drop the separators a cut leaves at the end. Default: leave them. */
  readonly trimCut?: boolean
  /** What an empty slug becomes. Default: the empty string. */
  readonly fallback?: string
  /**
   * `nfkd`: accented letters break into base letter and mark, the mark reads as
   * a separator ("naïve" is "nai-ve"). `nfkd-ascii`: the marks and every other
   * non-ASCII character are dropped first ("naïve" is "naive"). Default: no
   * normalization, so any non-ASCII character reads as a separator.
   */
  readonly normalize?: "nfkd" | "nfkd-ascii"
  /** Lowercase before normalizing, not after. Exotic letters (a superscript capital) differ between the two. */
  readonly lowerFirst?: boolean
}

/**
 * Words made into a key: ASCII lowercase letters and digits joined by one
 * separator, none at either end. Every option changes the output for some
 * text, so a stored key keeps the options it was made with.
 */
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
  if (normalize === "nfkd-ascii") value = value.replace(/[^\x00-\x7F]/g, "")
  if (!lowerFirst) value = value.toLowerCase()
  value = value
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^${separator}+|${separator}+$`, "g"), "")
  if (max !== undefined) value = value.slice(0, max)
  if (trimCut) value = value.replace(new RegExp(`${separator}+$`), "")
  return value === "" ? fallback : value
}

/** `base`, else `base-2`, `base-3`, … : the first name `taken` does not hold. */
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
