import type { JsonRecord, JsonValue } from "../../common/json.js"

export type AnswerBlockValues = Readonly<Record<string, JsonValue>>

export interface SavedAnswerBlock extends JsonRecord {
  readonly message_id: string
  readonly block_index: number
  readonly state: AnswerBlockValues
}

export interface AnswerBlockStates extends JsonRecord {
  readonly blocks: ReadonlyArray<SavedAnswerBlock>
}

export interface SaveAnswerBlockInput {
  readonly state: AnswerBlockValues
}
