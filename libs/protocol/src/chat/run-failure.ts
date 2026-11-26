import { parseJsonTextOrUndefined } from "../common/json-text.js"
import { CHAT_RUN_ERROR_CODE } from "./events/run.js"

const REQUEST_INVALID_TEXT =
  "Arden couldn't send this to the model. Try again — if it keeps happening, send a report."

const IMAGE_TOO_LARGE_TEXT = "An image was too large to send. Arden now shrinks it — try again."
const IMAGE_TOO_LARGE = /image you provided requires \d+ patches|resize the image and try again/i

const MODEL_UNAVAILABLE_NEXT = "Pick another model for this chat, then try again."
const MODEL_UNAVAILABLE_FALLBACK = "The model server won't run this model."

export const providerSentence = (message: string): string | undefined => {
  const start = message.indexOf("{")
  if (start < 0) return undefined
  const parsed = parseJsonTextOrUndefined(message.slice(start))
  if (typeof parsed !== "object" || parsed === null) return undefined
  const error = "error" in parsed ? parsed.error : undefined
  if (typeof error === "string") return error.trim() || undefined
  if (typeof error === "object" && error !== null && "message" in error)
    return typeof error.message === "string" ? error.message.trim() || undefined : undefined
  if ("detail" in parsed && typeof parsed.detail === "string")
    return parsed.detail.trim() || undefined
  return undefined
}

export const RUN_FAILURE_TEXT = { raw: "raw", explained: "explained" } as const

export type RunFailureText =
  | { readonly kind: typeof RUN_FAILURE_TEXT.raw; readonly text: string }
  | {
      readonly kind: typeof RUN_FAILURE_TEXT.explained
      readonly text: string
      readonly detail: string
    }

const LEGACY_REQUEST_INVALID: ReadonlyArray<RegExp> = [
  /request failed with status 400\b[\s\S]*"type"\s*:\s*"invalid_request_error"/,
  /^Stored (?:OpenAI|provider) (?:tool|response) history /,
  /refused the run \(HTTP 400\): (?:Invalid Value: 'tools'|Async tools are not supported|.*reserved namespace)/
]

export const isRequestInvalid = (code: string | null | undefined, message: string): boolean =>
  code === CHAT_RUN_ERROR_CODE.requestInvalid ||
  ((code === CHAT_RUN_ERROR_CODE.providerError || code === null || code === undefined) &&
    LEGACY_REQUEST_INVALID.some((pattern) => pattern.test(message.trim())))

export const runFailureText = (
  code: string | null | undefined,
  message: string
): RunFailureText => {
  if (code === CHAT_RUN_ERROR_CODE.modelUnavailable)
    return {
      kind: RUN_FAILURE_TEXT.explained,
      text: `${providerSentence(message) ?? MODEL_UNAVAILABLE_FALLBACK} ${MODEL_UNAVAILABLE_NEXT}`,
      detail: message
    }
  if (!isRequestInvalid(code, message)) return { kind: RUN_FAILURE_TEXT.raw, text: message }
  return {
    kind: RUN_FAILURE_TEXT.explained,
    text: IMAGE_TOO_LARGE.test(message) ? IMAGE_TOO_LARGE_TEXT : REQUEST_INVALID_TEXT,
    detail: message
  }
}

const TASK_REFUSAL = /^\w+ refused the run \(HTTP \d+\): /

export const FAILURE_SURFACE = { chat: "chat", task: "task" } as const

export type FailureSurface = (typeof FAILURE_SURFACE)[keyof typeof FAILURE_SURFACE]

export const failureSentence = (message: string, surface: FailureSurface): string => {
  const failure = runFailureText(undefined, message)
  const sentence =
    failure.kind === RUN_FAILURE_TEXT.explained
      ? failure.text
      : (providerSentence(message) ?? message.replace(TASK_REFUSAL, ""))
  return surface === FAILURE_SURFACE.task ? inTaskWords(sentence) : sentence
}

export const inTaskWords = (reason: string): string =>
  reason
    .replace(
      REQUEST_INVALID_TEXT,
      "Arden couldn't send this to the model. Retry — if it keeps happening, send a report."
    )
    .replace(IMAGE_TOO_LARGE_TEXT, "An image was too large to send. Arden now shrinks it — retry.")
    .replace(MODEL_UNAVAILABLE_NEXT, "Pick another model for this chat, then Retry.")
