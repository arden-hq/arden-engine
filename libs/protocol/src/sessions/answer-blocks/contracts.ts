import type { JsonRecord, JsonValue } from "../../common/json.js"

/** What the person set on one `arden:ui` block: `$name` → value, only the
 *  names the block declares (the server drops the rest before saving). */
export type AnswerBlockValues = Readonly<Record<string, JsonValue>>

/** One block's saved values, addressed by its message and its place among
 *  that message's blocks. */
export interface SavedAnswerBlock extends JsonRecord {
  readonly message_id: string
  readonly block_index: number
  readonly state: AnswerBlockValues
}

/** Every saved block in one chat. */
export interface AnswerBlockStates extends JsonRecord {
  readonly blocks: ReadonlyArray<SavedAnswerBlock>
}

export interface SaveAnswerBlockInput {
  readonly state: AnswerBlockValues
}
