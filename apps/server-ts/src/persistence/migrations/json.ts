import { JsonTextError, parseJsonText } from "@arden-hq/std/json-text"

export const parseMigrationJson = (text: string): unknown => {
  try {
    return parseJsonText(text)
  } catch (cause) {
    throw cause instanceof JsonTextError ? cause.cause : cause
  }
}
