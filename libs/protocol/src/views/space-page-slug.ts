import { slugify } from "@arden-hq/std/slug"

/**
 * The folder and file name a Space's wiki page is stored under, from its title.
 * The server names the page with it and the Memory tree reads it back to show
 * the title, so both sides share this one rule. Stored names keep it.
 */
export const spacePageSlug = (title: string): string =>
  slugify(title, { normalize: "nfkd-ascii", max: 80, trimCut: true, fallback: "space" })
