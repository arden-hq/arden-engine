import type { JsonRecord } from "../common/json.js"
import type { ChatUpdate, CommunicationEnvelope } from "./communication.js"
import type { SessionRuntimeSnapshot } from "./runtime.js"

export type HistoryImageMediaType = "image/png" | "image/jpeg"

/** A UI surface that writes a message for the person to confirm: a visualization's
 *  "Send to chat" bar, or an answer block's Button text sent unchanged. Such a message is the person's send, never their own words,
 *  so approval review and offers do not read it as their instruction. "cli": sent
 *  with the command line's capability, which an agent's own command can hold;
 *  the server sets it. */
export type ChatSentFrom = "visualization" | "answer" | "cli"

/** A connection the person made or declined from an offer card. It arrives
 *  at the time it happened, as its own row, and tells the agent that offered it. */
export interface ConnectionArrival {
  /** The `capability_propose` call whose card this answers. */
  readonly tool_call_id: string
  /** The name the card showed for the connection. */
  readonly server: string
  readonly outcome: "connected" | "declined"
  /** When the card was offered; the folded card shows this time. */
  readonly offered_at: string
  /** When the person connected or declined. */
  readonly at: string
}

/** A validated image projected from one stored user-message content block. */
export interface HistoryImage extends JsonRecord {
  readonly type: "image"
  readonly media_type: HistoryImageMediaType
  /** Base64 bytes without a data-URL prefix. */
  readonly data: string
}

export type InteractionActorType = "agent" | "workflow" | "tool" | "harness" | "user"

/** Who a message is from or to. The server checks it agrees with `InteractionActor` in libs/loop. */
export interface InteractionActor extends JsonRecord {
  readonly type: InteractionActorType
  readonly id: string
  /** Stable human-readable identity supplied by the sender's owner. */
  readonly display_name?: string
}

/** What produced the interaction: the run, tool call, message or workflow. */
export interface InteractionReference extends JsonRecord {
  readonly type: "message" | "run" | "tool_call" | "workflow"
  readonly id: string
}

/** `interrupted`: the sender stopped because Arden restarted — routine, not
 *  a failure. */
export type InteractionOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "needs_attention"
  | "interrupted"

interface InteractionBase extends JsonRecord {
  readonly from: InteractionActor
  readonly to: InteractionActor
  readonly content: string
  /** One plain line for the row when `content` is written for the recipient. */
  readonly preview?: string
  readonly causedBy?: InteractionReference
}

/** The stored provenance of one delivered message: who sent it and why.
 *  The server checks it agrees with `Interaction` in libs/loop; the client
 *  reads the sender from here rather than sniffing ids or flags. */
export type Interaction =
  | (InteractionBase & { readonly kind: "message" | "assignment" | "event" | "instruction" })
  | (InteractionBase & {
      readonly kind: "completion"
      readonly outcome: InteractionOutcome
    })

/** An agent's report retained for the parent's model input and inspection. */
export interface AgentResult extends JsonRecord {
  readonly session_id: string
  readonly name: string
  readonly content: string
  /** Legacy preview retained with the complete report. */
  readonly preview?: string
}

export interface HistoryContextBlock extends JsonRecord {
  readonly type?: "context"
  readonly content_type: string
  readonly content?: string | null
  readonly metadata?: Readonly<Record<string, string>> | null
}

/** A Gmail provider receipt. Its presence proves Gmail accepted one send. */
export interface GmailSendReceipt extends JsonRecord {
  readonly kind: "gmail_send_v1"
  readonly provider_message_id: string
  readonly provider_thread_id: string
  readonly recipient: string
  /** Local observation time after Gmail accepted the send; not Gmail's send time. */
  readonly confirmed_at: string
}

export interface HistoryToolCall extends JsonRecord {
  readonly id: string
  readonly name: string
  readonly arguments: string
  readonly execution?: "runtime" | "provider"
  readonly started_at?: number
  readonly parent_id?: string | null
  readonly display_name?: string
  readonly display_title?: string
  readonly result?: string
  readonly kind?: string
  readonly icon?: string | null
  readonly noun?: string | null
  readonly source?: string | null
  /** "conversation": the result is content the user always sees, so the call
   *  rides in the conversation stream as well as the work projection. */
  readonly presentation?: "work" | "conversation" | "status"
  readonly is_error?: boolean
  readonly retryable?: boolean | null
  readonly outcome?: ToolOutcome
  /** Present only after Gmail accepted a send and returned provider evidence. */
  readonly gmail_send_receipt?: GmailSendReceipt
  /** Structured result data, served for conversation-surface calls and, as
   *  `source_refs`, for provider calls (they have no tool row). */
  readonly data?: unknown
  /** Wall-clock run time from the tool execution ledger. */
  readonly duration_ms?: number
}

export type HistoryAssistantOutputPart =
  | {
      readonly type: "reasoning"
      readonly text: string
      /** Zero-based position in the durable assistant output_parts array. */
      readonly source_index: number
    }
  | {
      readonly type: "text"
      readonly text: string
      readonly phase?: AssistantTextPhase
      /** Zero-based position in the durable assistant output_parts array. */
      readonly source_index: number
    }
  | {
      readonly type: "tool_call"
      readonly tool_call_id: string
      readonly execution: "runtime" | "provider"
      /** Zero-based position in the durable assistant output_parts array. */
      readonly source_index: number
    }

/** The chat a handed-over message came from: its id, and the public ref links take. */
interface ChatHandoffSource extends JsonRecord {
  readonly session_id: string
  readonly session_ref: string
}

interface HistoryMessageBase extends JsonRecord {
  /** Static arrival or scheduled letter carried by this meta transcript row. */
  readonly communication?: CommunicationEnvelope
  /** On the meta row that brought a background update to Arden as its turn's input. */
  readonly update?: ChatUpdate
  readonly agent_result?: AgentResult
  readonly content: string
  /** Who sent this message, when the harness delivered it on someone's behalf. */
  readonly interaction?: Interaction
  /** Context blocks are retained in server history even when UI projections omit them. */
  readonly context?: ReadonlyArray<HistoryContextBlock>
  readonly reasoning_content?: string
  readonly tool_calls?: ReadonlyArray<HistoryToolCall>
  readonly output_parts?: ReadonlyArray<HistoryAssistantOutputPart>
  readonly tool_call_id?: string
  readonly data?: unknown
  /** Set on a compact-view row: long arguments and output were cut to a prefix. */
  readonly compact?: boolean
  readonly message_id: string
  /** Caller-owned retry identity when the message originated from a client send. */
  readonly client_id?: string
  readonly seq?: number
  readonly created_at?: string
  /** A steer's stamp: when the running turn took it in; absent on rows that started their turn. */
  readonly applied_at?: string
  readonly is_meta?: boolean
  readonly reply_to?: {
    readonly message_id: string
    readonly role: "user" | "assistant"
    readonly content: string
  }
  /** The Recipe a user message was started from, by its Skill name. */
  readonly recipe?: string
  /** The Run question whose answer this hidden row carries to the run. */
  readonly question_answer?: { readonly question_id: string }
  /** On a hidden-context row that tells the agent a connection card was answered. */
  readonly connection?: ConnectionArrival
  /** A message Arden handed over from another chat (`session_send_message`): it
   *  reads as Arden's handoff from that chat, never as the user's own message. */
  readonly from_chat?: ChatHandoffSource
  /** Original user message copied here; the interaction, if any, names its carrier. */
  readonly forwarded_from?: ChatHandoffSource & { readonly message_id: string }
  /** A message whose words a UI surface wrote and the person confirmed. */
  readonly sent_from?: ChatSentFrom
  /** Durable physical turn membership assigned by the server write path. */
  readonly turn_id: string
  readonly automation?: {
    readonly task_id: string
    readonly name: string
    readonly prompt: string
    readonly context_mode: "fresh" | "continue" | "fork"
  }
}

export type HistoryMessage = HistoryMessageBase &
  (
    | {
        readonly role: "user"
        readonly images?: ReadonlyArray<HistoryImage>
      }
    | {
        readonly role: "assistant"
        readonly images?: never
      }
    | {
        readonly role: "tool"
        readonly images?: never
        readonly is_error?: boolean
        readonly retryable?: boolean | null
        readonly outcome?: ToolOutcome
      }
  )

export interface TurnShell extends JsonRecord {
  readonly turn_id: string
  readonly message_start_seq: number
  readonly message_end_seq: number
  readonly started_at: string
  readonly ended_at: string
  readonly has_work: boolean
  /** Work beyond reasoning: a tool call ran. A turn that only reasoned
   *  "thought"; one that ran tools "worked". */
  readonly has_tool_work: boolean
  /** Which tools the turn called and how often, so a settled fold can say
   *  what it did before its rows are paged in. */
  readonly tool_calls?: ReadonlyArray<TurnToolCallCount>
  /** The turn's last run failed (it ended with RUN_ERROR): its code and the
   *  message the reader was shown. Both present together, or both absent. */
  readonly error_code?: string
  readonly error_message?: string
}

export interface TurnToolCallCount extends JsonRecord {
  readonly name: string
  readonly display_name: string | null
  readonly count: number
  /** How many of `count` the user turned down on their approval cards: they
   *  never ran. Absent from a server that predates it, which means none. */
  readonly rejected?: number
}

export interface HistoryPage extends JsonRecord {
  readonly has_more_before: boolean
  readonly has_more_after: boolean
  readonly before?: string | null
  readonly after?: string | null
}

export interface ContextBudgetSnapshot extends JsonRecord {
  readonly model: string | null
  readonly hard_limit: number | null
  readonly compaction_trigger: number | null
  readonly input_tokens: number
  readonly message_count: number
}

export interface HistoryResponse extends JsonRecord {
  readonly messages: ReadonlyArray<HistoryMessage>
  /** Bounded work projection for the exact active physical turn. */
  readonly active_work_tail: TurnWorkResponse | null
  readonly runtime: SessionRuntimeSnapshot
  readonly page: HistoryPage
  readonly context_budget: ContextBudgetSnapshot
  readonly turn_shells?: ReadonlyArray<TurnShell>
}

export interface TurnWorkResponse extends JsonRecord {
  readonly turn_id: string
  /** Work carriers plus their matching hydrated tool-result rows. */
  readonly messages: ReadonlyArray<HistoryMessage>
  /** Cursors and counts are over work carriers, not hydrated result rows. */
  readonly page: HistoryPage
}

/** Everything one turn did, across all of its runs, for the Details panel:
 *  every work carrier in compact form, past the page window. */
export interface TurnDetailsResponse extends JsonRecord {
  readonly turn_id: string
  readonly messages: ReadonlyArray<HistoryMessage>
  /** False when the turn has more work carriers than one read returns; the
   *  read then holds the newest ones. */
  readonly complete: boolean
}

export type AssistantTextPhase = "commentary" | "final_answer"

export interface ToolOutcome extends JsonRecord {
  readonly status: "succeeded" | "failed" | "denied" | "uncertain"
  readonly error?: {
    readonly code: string
    readonly retryable: boolean
    readonly recovery_action?: string
    readonly diagnostic_ref?: string
  }
  readonly effect?: {
    readonly operation: string
    readonly target: string
    readonly before_ref?: string
    readonly after_ref?: string
  }
  readonly verification?: {
    readonly postcondition: string
    readonly observed: string
    readonly confidence?: number
  }
  readonly receipt?: string
}
