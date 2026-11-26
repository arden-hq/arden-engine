import { errorMessage } from "./errors.js"

export class JsonTextError extends Error {
  override readonly name = "JsonTextError"
}

export const parseJsonText = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new JsonTextError(errorMessage(cause), { cause })
  }
}
