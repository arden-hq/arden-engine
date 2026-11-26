import { JsonTextError, parseJsonText as parseText } from "@arden-hq/std/json-text"

import { ProtocolError } from "./errors.js"

export const parseJsonTextOrUndefined = (text: string): unknown => {
  try {
    return parseText(text)
  } catch (cause) {
    if (cause instanceof JsonTextError) return undefined
    throw cause
  }
}

export const parseJsonText = (text: string): unknown => {
  try {
    return parseText(text)
  } catch (cause) {
    if (cause instanceof JsonTextError)
      throw new ProtocolError("The text is not JSON", { kind: "decode" })
    throw cause
  }
}

export const parseJsonBody = async (response: Response): Promise<unknown> =>
  parseJsonText(await response.text())
