import {
  ToolChoice,
  type ChatMessage,
  type CompletionResponse,
  type ModelProvider,
  type ModelProviderRequest
} from "@arden-hq/loop"
import { withUntrustedDataRule } from "../models/instructions.js"
import { PROMPT_TEXT } from "../prompts/catalog.js"
import { HANDOFF_BYTES_PER_TOKEN, handoffContent } from "./handoff.js"

const MAX_PROMPT_HEADROOM_TOKENS = 2_000
const OMITTED_HISTORY = "[oldest history omitted because it did not fit the summarizer context]"

const fitSource = (
  source: string,
  priorSummary: string | undefined,
  contextWindow: number,
  maxOutputTokens: number
): string => {
  const promptHeadroom = Math.min(
    MAX_PROMPT_HEADROOM_TOKENS,
    Math.max(1, Math.floor(contextWindow / 4))
  )
  const maxChars = Math.max(1, contextWindow - maxOutputTokens - promptHeadroom)
  const prior =
    priorSummary === undefined
      ? ""
      : `[PRIOR HANDOFF — reconcile with newer evidence]\n${priorSummary}`
  if (source.length === 0 || prior.length >= maxChars) return prior.slice(0, maxChars)
  const separator = prior.length === 0 ? "" : "\n\n"
  const available = maxChars - prior.length - separator.length
  if (available <= 0) return prior.slice(0, maxChars)
  if (source.length <= available) return `${prior}${separator}${source}`
  const suffixLength = Math.max(0, available - OMITTED_HISTORY.length - 2)
  const recent =
    suffixLength === 0
      ? OMITTED_HISTORY.slice(0, available)
      : `${OMITTED_HISTORY}\n\n${source.slice(-suffixLength)}`
  return `${prior}${separator}${recent}`
}

export interface SummarizeContextInput {
  readonly provider: ModelProvider
  readonly model: string
  readonly reasoningEffort: string | null
  readonly sessionRef: string
  readonly sourceSessionRef?: string | undefined
  readonly sourceText: string
  readonly priorSummary?: string
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly signal?: AbortSignal
  readonly onResponse: (response: CompletionResponse) => void
  readonly cachedRequest?: ModelProviderRequest | undefined
  readonly fallback?: "standalone" | "none"
}

export const summarizeContext = async (input: SummarizeContextInput): Promise<string> => {
  const maxOutputTokens = Math.min(
    input.maxOutputTokens,
    Math.max(1, Math.floor(input.contextWindow / 4))
  )
  const maxBytes = maxOutputTokens * HANDOFF_BYTES_PER_TOKEN
  const summaryBytes = maxBytes - Buffer.byteLength(handoffContent({ ...input, summary: "" }))
  if (summaryBytes <= 0) throw new Error("Compaction budget cannot fit its recovery reference")
  const instruction = `${withUntrustedDataRule(PROMPT_TEXT.compaction)}\n\nReturn only the handoff, targeting at most ${Math.floor(summaryBytes / 20)} words and never exceeding ${summaryBytes} UTF-8 bytes. The full transcript is recoverable through session_search_transcripts and session_read using session_ref ${JSON.stringify(input.sessionRef)}. Include short, distinctive lookup hints for omitted details. Recent messages will also be retained verbatim, so keep their detail concise. Do not call tools.`
  const standalone: ModelProviderRequest = {
    model: input.model,
    messages: [
      { role: "system", content: withUntrustedDataRule(PROMPT_TEXT.compaction) },
      {
        role: "user",
        content: fitSource(
          input.sourceText,
          input.priorSummary,
          input.contextWindow,
          maxOutputTokens
        )
      }
    ],
    tools: [],
    deferredTools: [],
    toolChoice: ToolChoice.NONE,
    renderInteraction: () => {
      throw new Error("Standalone compaction only carries serialized text")
    },
    ...(input.reasoningEffort === null ? {} : { reasoningEffort: input.reasoningEffort })
  }
  if (input.cachedRequest === undefined && input.fallback === "none")
    throw new Error("No reusable request for idle compaction")
  let request = input.cachedRequest ?? standalone
  let summary: string
  try {
    summary = await complete(input, request, instruction, maxOutputTokens)
  } catch (cause) {
    if (input.signal?.aborted === true || input.fallback === "none" || request === standalone)
      throw cause
    request = standalone
    summary = await complete(input, request, instruction, maxOutputTokens)
  }
  if (Buffer.byteLength(handoffContent({ ...input, summary })) > maxBytes) {
    summary = await complete(
      input,
      request,
      `${instruction}\nThe previous candidate was too long. Rewrite more concisely: keep active constraints and next actions; replace historical detail with lookup hints. Stay within the stated budget.`,
      maxOutputTokens
    )
  }
  if (Buffer.byteLength(handoffContent({ ...input, summary })) > maxBytes)
    throw new Error("Compaction handoff still exceeds its byte budget after one rewrite")
  return summary
}

const complete = async (
  input: SummarizeContextInput,
  request: ModelProviderRequest,
  instruction: string,
  maxOutputTokens: number
): Promise<string> => {
  input.signal?.throwIfAborted()
  const session = await input.provider.openSession?.()
  const provider = session ?? input.provider
  try {
    let response: CompletionResponse | undefined
    const messages: ReadonlyArray<ChatMessage> = [
      ...request.messages,
      { role: "user", content: instruction }
    ]
    for await (const item of await provider.stream({
      ...request,
      messages,
      toolChoice: ToolChoice.NONE,
      maxOutputTokens,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    })) {
      if (item._tag === "Completed") {
        input.onResponse(item)
        response = item
      }
    }
    input.signal?.throwIfAborted()
    if (
      response === undefined ||
      response.continuation === true ||
      response.finish_reason !== "stop" ||
      (response.message.tool_calls?.length ?? 0) > 0 ||
      (response.message.provider_tool_calls?.length ?? 0) > 0
    )
      throw new Error("Compaction did not return a complete tool-free handoff")
    const summary =
      typeof response.message.content === "string" ? response.message.content.trim() : ""
    if (summary.length === 0) throw new Error("Compaction model returned an empty handoff")
    return summary
  } finally {
    await session?.close()
  }
}
