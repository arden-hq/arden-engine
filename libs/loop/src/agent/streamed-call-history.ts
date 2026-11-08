import type {
  AssistantMessage,
  ChatMessage,
  ProviderToolCall,
  ToolCall
} from "../contracts/messages.js"
import type { CompletionResponse, ProviderMessage } from "../contracts/provider.js"
import { InvalidModelResponseError } from "../errors.js"

const sameCall = (left: ToolCall, right: ToolCall): boolean =>
  left.id === right.id &&
  left.function.name === right.function.name &&
  left.function.arguments === right.function.arguments &&
  left.async === right.async

export class StreamedCallHistory {
  readonly calls = new Map<string, ToolCall>()
  readonly persistedIds = new Set<string>()
  readonly providerCalls = new Map<string, ProviderToolCall>()
  private fragments = 0
  private readonly text: string[] = []

  constructor(private readonly history: ChatMessage[]) {}

  get persisted(): boolean {
    return this.fragments > 0
  }

  get count(): number {
    return this.fragments
  }

  add(call: ToolCall): void {
    this.calls.set(call.id, call)
  }

  persist(message: AssistantMessage): void {
    this.history.push(message)
    this.text.push(typeof message.content === "string" ? message.content : "")
    this.fragments += 1
    for (const call of message.tool_calls ?? []) this.persistedIds.add(call.id)
    for (const call of message.provider_tool_calls ?? []) this.providerCalls.set(call.id, call)
  }

  reset(): void {
    this.calls.clear()
  }

  committed(model: string): CompletionResponse {
    const calls = [...this.calls.values()]
    return {
      _tag: "Completed",
      model,
      finish_reason: calls.length > 0 ? "tool_calls" : "stop",
      ...(calls.length > 0 ? {} : { continuation: true }),
      usage: { completion_tokens: 0 },
      message: {
        role: "assistant",
        content: this.text.join(""),
        tool_calls: calls,
        reasoning_content: null,
        provider_tool_calls: [...this.providerCalls.values()]
      }
    }
  }

  validate(message: ProviderMessage): void {
    const calls = message.tool_calls ?? []
    if (this.persisted && this.text.join("") !== (message.content ?? ""))
      throw new InvalidModelResponseError(
        "terminal response changed or omitted completed text fragments"
      )
    for (const ready of this.calls.values()) {
      const final = calls.find((call) => call.id === ready.id)
      if (final === undefined || !sameCall(ready, final))
        throw new InvalidModelResponseError(
          "terminal response changed or omitted a completed tool call"
        )
    }
    if (this.persisted && calls.some((call) => !this.calls.has(call.id)))
      throw new InvalidModelResponseError(
        "terminal response contains a tool call without its completed fragment"
      )
  }

  finish(message: AssistantMessage): void {
    if (!this.persisted) this.history.push(message)
  }
}
