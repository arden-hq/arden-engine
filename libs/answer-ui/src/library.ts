import { createLibrary, createParser, type ParseResult } from "@openuidev/lang-core"
import { ANSWER_PARTS, COMPONENT_NAME } from "./parts.js"

export const ANSWER_UI_ROOT = COMPONENT_NAME.Stack

export const library = createLibrary({
  root: ANSWER_UI_ROOT,
  components: Object.values(ANSWER_PARTS)
})

const parser = createParser(library.toJSONSchema(), ANSWER_UI_ROOT)

export function parseUnguarded(source: string): ParseResult {
  return parser.parse(source)
}
