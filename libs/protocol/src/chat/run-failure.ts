/**
 * What a failed run says to the person. A request Arden built wrong is
 * Arden's defect: the person reads one plain sentence, and the provider's raw
 * text stays behind it for Details and Report problem.
 */

const REQUEST_INVALID_TEXT =
  "Arden couldn't send this to the model. Try again — if it keeps happening, send a report."

const IMAGE_TOO_LARGE_TEXT = "An image was too large to send. Arden now shrinks it — try again."
const IMAGE_TOO_LARGE = /image you provided requires \d+ patches|resize the image and try again/i

const MODEL_UNAVAILABLE_NEXT = "Pick another model for this chat, then try again."
const MODEL_UNAVAILABLE_FALLBACK = "The model provider won't run this model on this account."

/**
 * The provider's own sentence inside "<Provider> request failed with status
 * N: {json}": `error.message`, or the bare `detail` the Codex backend sends.
 * The transport envelope around it is noise to the person reading.
 */
export const providerSentence = (message: string): string | undefined => {
  const start = message.indexOf("{")
  if (start < 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(message.slice(start))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const error = "error" in parsed ? parsed.error : undefined
  if (typeof error === "string") return error.trim() || undefined
  if (typeof error === "object" && error !== null && "message" in error)
    return typeof error.message === "string" ? error.message.trim() || undefined : undefined
  if ("detail" in parsed && typeof parsed.detail === "string")
    return parsed.detail.trim() || undefined
  return undefined
}

export interface RunFailureText {
  /** The words the chat error row shows. */
  readonly text: string
  /** The raw failure behind `text`, for Details and Report problem; undefined when `text` is it. */
  readonly detail: string | undefined
}

/**
 * Failures stored before `request_invalid` existed carry `provider_error`
 * and only the raw text, so the known shapes of Arden's own bad requests are
 * recognised here, on read, and nowhere else: a provider's 400 naming the
 * request invalid, the adapter refusing its stored history, and a Task line
 * written from either ("OpenAI refused the run (HTTP 400): …").
 */
const LEGACY_REQUEST_INVALID: ReadonlyArray<RegExp> = [
  /request failed with status 400\b[\s\S]*"type"\s*:\s*"invalid_request_error"/,
  /^Stored (?:OpenAI|provider) (?:tool|response) history /,
  /refused the run \(HTTP 400\): (?:Invalid Value: 'tools'|Async tools are not supported|.*reserved namespace)/
]

/** True when the run failed on a request Arden built wrong, whatever its age. */
export const isRequestInvalid = (code: string | null | undefined, message: string): boolean =>
  code === "request_invalid" ||
  ((code === "provider_error" || code === null || code === undefined) &&
    LEGACY_REQUEST_INVALID.some((pattern) => pattern.test(message.trim())))

/** The chat error row for a failed run: plain words for Arden's own bad request
 *  and for a refused model (with what to do), else the message. */
export const runFailureText = (
  code: string | null | undefined,
  message: string
): RunFailureText => {
  if (code === "model_unavailable")
    return {
      text: `${providerSentence(message) ?? MODEL_UNAVAILABLE_FALLBACK} ${MODEL_UNAVAILABLE_NEXT}`,
      detail: message
    }
  if (!isRequestInvalid(code, message)) return { text: message, detail: undefined }
  return {
    text: IMAGE_TOO_LARGE.test(message) ? IMAGE_TOO_LARGE_TEXT : REQUEST_INVALID_TEXT,
    detail: message
  }
}

const TASK_REFUSAL = /^\w+ refused the run \(HTTP \d+\): /

/**
 * A failure kept as text alone (a Task's line, a worker's report), with no
 * code to read: plain words for Arden's own bad request, else the provider's
 * own sentence out of its transport envelope, else the text as written. On a
 * Task's surface the words name the Task's own button.
 */
export const failureSentence = (message: string, surface: "chat" | "task"): string => {
  const failure = runFailureText(undefined, message)
  const sentence =
    failure.detail !== undefined
      ? failure.text
      : (providerSentence(message) ?? message.replace(TASK_REFUSAL, ""))
  return surface === "task" ? inTaskWords(sentence) : sentence
}

/**
 * The same sentence where a Task stopped on it: the Task's button is Retry,
 * not the chat row's Try again, so the words name the button the person sees.
 * Lines stored with the chat wording read the same way.
 */
export const inTaskWords = (reason: string): string =>
  reason
    .replace(
      REQUEST_INVALID_TEXT,
      "Arden couldn't send this to the model. Retry — if it keeps happening, send a report."
    )
    .replace(IMAGE_TOO_LARGE_TEXT, "An image was too large to send. Arden now shrinks it — retry.")
    .replace(MODEL_UNAVAILABLE_NEXT, "Pick another model for this chat, then Retry.")
