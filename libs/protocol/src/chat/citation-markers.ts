/** OpenAI models write web citations into their text as private-use framed
 *  tokens: `\uE200cite\uE202turn376125search1\uE201`, several ids joined by
 *  `\uE202`. The ids index the model's own search results and resolve to
 *  nothing a reader can open; the web pages a turn searched already reach the
 *  reader as that turn's Sources. The provider drops them from streamed answer
 *  text, but they also arrive through text the model writes elsewhere (agent
 *  messages, reports, tool arguments) and sit in rows stored before the
 *  provider filter, so every surface that shows stored text removes them.
 *
 *  The same private-use framing carries Arden's own `visualize` reference,
 *  which is not a citation and stays.
 *
 *  @see https://developers.openai.com/api/docs/guides/citation-formatting */

/** A marker with the spaces a model puts before it (`scale. ⟨cite⟩`). Ids
 *  and locators are short words (`turn4view0`, `L12-L20`); a marker cut
 *  before its stop ends where its ids end, never eating the prose after it. */
const CITATION = /[ \t]*\uE200cite(?:\uE202[\w.:-]*)*\uE201?/gu
const CUT_PREFIX = /[ \t]*\uE200(?:c(?:i(?:t(?:e)?)?)?)?$/u

export const stripCitationMarkers = (text: string): string =>
  text.includes("\uE200") ? text.replace(CITATION, "").replace(CUT_PREFIX, "") : text
