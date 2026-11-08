import type { AgentEvent } from "../contracts/events.js"
import type { AssistantOutputPart } from "../contracts/messages.js"

type ReadablePart = Extract<AssistantOutputPart, { readonly type: "text" | "reasoning" }>

interface OpenBlock {
  readonly kind: "text" | "reasoning"
  readonly id: string
  readonly partIndex: number | undefined
  text: string
}

export class ModelOutputProjection {
  parts: AssistantOutputPart[] = []
  readonly textMessageIdsByPartIndex = new Map<number, string>()
  readonly messageIds = new Set<string>()
  fragmentId: string
  lastTextId: string
  private counts = { text: 0, reasoning: 0 }
  private open: OpenBlock | undefined

  constructor(
    private readonly emit: (event: AgentEvent) => Promise<void>,
    private readonly mintId: (kind: "text" | "reasoning", index: number) => string
  ) {
    this.fragmentId = mintId("text", 0)
    this.lastTextId = this.fragmentId
  }

  beginFragment(): void {
    this.parts = []
    this.textMessageIdsByPartIndex.clear()
    this.messageIds.clear()
    this.counts = { text: 0, reasoning: 0 }
    this.open = undefined
    this.fragmentId = this.mintId("text", 0)
    this.lastTextId = this.fragmentId
  }

  async close(): Promise<void> {
    const block = this.open
    if (block === undefined) return
    this.open = undefined
    if (block.kind === "reasoning") {
      await this.emit({
        _tag: "ReasoningEnded",
        depth: 0,
        parent_id: null,
        message_id: block.id
      })
      return
    }
    await this.emit({
      _tag: "TextEnded",
      depth: 0,
      parent_id: null,
      message_id: block.id,
      content: block.text
    })
  }

  async delta(kind: "text" | "reasoning", content: string): Promise<void> {
    const text = kind === "reasoning" && this.open?.kind !== kind ? content.trimStart() : content
    if (text.length === 0) return
    if (this.open?.kind !== kind) {
      await this.close()
      await this.start(kind, this.parts.length)
      this.parts.push({ type: kind, text: "" })
    }
    await this.append(text)
  }

  canExtend(parts: ReadonlyArray<AssistantOutputPart>): boolean {
    return this.parts.every((part, index) => {
      const canonical = parts[index]
      if (part.type === "tool_call") {
        return (
          canonical?.type === "tool_call" &&
          canonical.execution === part.execution &&
          canonical.tool_call_id === part.tool_call_id
        )
      }
      return (
        canonical?.type === part.type &&
        canonical.text.startsWith(part.text) &&
        (canonical.text.length === part.text.length || this.open?.partIndex === index)
      )
    })
  }

  async completePart(part: ReadablePart, index: number): Promise<void> {
    const streamed = this.parts[index]
    if (streamed !== undefined) {
      if (streamed.type === "tool_call") return
      const suffix = part.text.slice(streamed.text.length)
      if (suffix.length > 0) await this.append(suffix)
      if (this.open?.partIndex === index) await this.close()
      return
    }
    await this.close()
    await this.start(part.type, index)
    this.parts.push({ ...part, text: "" })
    if (part.text.length > 0) await this.append(part.text)
    await this.close()
  }

  async ensureText(): Promise<void> {
    if (this.counts.text > 0) return
    await this.close()
    await this.start("text", undefined)
  }

  private async start(kind: "text" | "reasoning", partIndex: number | undefined): Promise<void> {
    const index = this.counts[kind]++
    const id = kind === "text" && index === 0 ? this.fragmentId : this.mintId(kind, index)
    this.open = { kind, id, partIndex, text: "" }
    this.messageIds.add(id)
    if (kind === "text") {
      this.lastTextId = id
      if (partIndex !== undefined) this.textMessageIdsByPartIndex.set(partIndex, id)
      await this.emit({ _tag: "TextStarted", depth: 0, parent_id: null, message_id: id })
      return
    }
    await this.emit({ _tag: "ReasoningStarted", depth: 0, parent_id: null, message_id: id })
  }

  private async append(content: string): Promise<void> {
    const block = this.open
    if (block === undefined) return
    block.text += content
    if (block.partIndex !== undefined) {
      this.parts[block.partIndex] = { type: block.kind, text: block.text }
    }
    if (block.kind === "text") {
      await this.emit({
        _tag: "TextDelta",
        depth: 0,
        parent_id: null,
        message_id: block.id,
        content
      })
      return
    }
    await this.emit({
      _tag: "ReasoningDelta",
      depth: 0,
      parent_id: null,
      message_id: block.id,
      content
    })
  }
}
