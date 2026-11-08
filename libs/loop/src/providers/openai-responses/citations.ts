/**
 * Removes OpenAI citation markers from user-visible text.
 *
 * The API emits citations as framed private-use text:
 * `\uE200cite\uE202{source-id}[\uE202{locator}]\uE201`.
 * Applications must resolve the source ids or remove the markers before
 * display. Arden currently presents the resolved turn sources separately, so
 * this filter removes the protocol framing while preserving raw response items
 * for provider replay.
 *
 * @see https://developers.openai.com/api/docs/guides/citation-formatting
 */

const CITATION_START = "\uE200"
const CITATION_DELIMITER = "\uE202"
const CITATION_STOP = "\uE201"
const CITATION_PREFIX = `${CITATION_START}cite${CITATION_DELIMITER}`

type FilterState =
  | { readonly kind: "text" }
  | { readonly kind: "prefix"; readonly value: string }
  | { readonly kind: "citation" }

/** Stateful because a citation marker may span several streamed deltas. */
export class OpenAiCitationFilter {
  private state: FilterState = { kind: "text" }

  push(chunk: string): string {
    let visible = ""

    for (const character of chunk) {
      if (this.state.kind === "citation") {
        if (character === CITATION_STOP) this.state = { kind: "text" }
        continue
      }

      if (this.state.kind === "prefix") {
        const candidate = `${this.state.value}${character}`
        if (candidate === CITATION_PREFIX) {
          this.state = { kind: "citation" }
          continue
        }
        if (CITATION_PREFIX.startsWith(candidate)) {
          this.state = { kind: "prefix", value: candidate }
          continue
        }

        visible += this.state.value
        this.state =
          character === CITATION_START ? { kind: "prefix", value: character } : { kind: "text" }
        if (character !== CITATION_START) visible += character
        continue
      }

      if (character === CITATION_START) {
        this.state = { kind: "prefix", value: character }
      } else {
        visible += character
      }
    }

    return visible
  }

  /** Drops a truncated citation prefix or marker at the end of the response. */
  finish(): void {
    this.state = { kind: "text" }
  }
}

export const stripOpenAiCitations = (text: string): string => {
  const filter = new OpenAiCitationFilter()
  const visible = filter.push(text)
  filter.finish()
  return visible
}
