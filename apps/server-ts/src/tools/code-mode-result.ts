import { Option, Schema } from "effect"
import type { ScriptFields } from "../workflows/runtime/contract.js"

export const bodyFields = (
  text: string,
  { declaredJson = false }: { readonly declaredJson?: boolean } = {}
): ScriptFields => {
  const json = parseJsonBody(text, declaredJson)
  return json === undefined ? { text } : { text, json }
}

const JSON_OBJECT_START = "{"
const JSON_ARRAY_START = "["

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const parseJsonBody = (text: string, declaredJson: boolean): Schema.Json | undefined => {
  const trimmed = text.trim()
  if (trimmed === "") return undefined
  if (!declaredJson && trimmed[0] !== JSON_OBJECT_START && trimmed[0] !== JSON_ARRAY_START)
    return undefined
  return Option.getOrUndefined(decodeJson(trimmed))
}

export type ScriptToolDescription = {
  readonly name: string
  readonly description: string
  readonly input_schema: Schema.Json
  readonly returns: string
  readonly changes_state: boolean
}

export const SCRIPT_RETURNS =
  "{ content: string, preview: string, data: object | null }. `content` is written for the model; do not parse it. `data` is the tool's structured result; when it has `text` that is the raw body, and `json` is that body parsed when it is JSON."
