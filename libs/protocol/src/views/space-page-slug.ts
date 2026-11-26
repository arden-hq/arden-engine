import { slugify } from "@arden-hq/std/slug"

export const spacePageSlug = (title: string): string =>
  slugify(title, { normalize: "nfkd-ascii", max: 80, trimCut: true, fallback: "space" })
