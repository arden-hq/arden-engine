import {
  SPACE_CHANGE,
  SPACE_INSTRUCTIONS_INPUT,
  type CreateSpaceInput,
  type SpaceChange
} from "@arden-hq/protocol/spaces"
import { storedMark, type StoredMarkLook } from "../spaces/mark.js"
import {
  INSTRUCTIONS_SOURCE,
  type SpaceInstructionsSource,
  type SpaceRecord
} from "../spaces/store.js"

export interface InstructionsColumns {
  readonly instructions: string | null
  readonly instructions_source: SpaceInstructionsSource | null
}

export const instructionsColumns = (
  input: CreateSpaceInput["instructions"]
): InstructionsColumns => {
  switch (input.kind) {
    case SPACE_INSTRUCTIONS_INPUT.unwritten:
      return { instructions: null, instructions_source: null }
    case SPACE_INSTRUCTIONS_INPUT.cleared:
      return { instructions: null, instructions_source: INSTRUCTIONS_SOURCE.manual }
    case SPACE_INSTRUCTIONS_INPUT.written:
      return {
        instructions: input.text.trim() || null,
        instructions_source: INSTRUCTIONS_SOURCE.manual
      }
  }
}

export interface SpaceEdit extends InstructionsColumns {
  readonly name: string
  readonly mark: StoredMarkLook | null
  readonly instructionsChanged: boolean
}

const applyChange = (edit: SpaceEdit, change: SpaceChange): SpaceEdit => {
  switch (change.kind) {
    case SPACE_CHANGE.name:
      return { ...edit, name: change.name }
    case SPACE_CHANGE.instructions:
      return { ...edit, ...instructionsColumns(change.instructions), instructionsChanged: true }
    case SPACE_CHANGE.mark:
      return { ...edit, mark: storedMark(change.mark) }
  }
}

export const applySpaceChanges = (
  current: SpaceRecord,
  changes: ReadonlyArray<SpaceChange>
): SpaceEdit =>
  changes.reduce(applyChange, {
    name: current.name,
    instructions: current.instructions,
    instructions_source: current.instructions_source,
    mark: current.mark,
    instructionsChanged: false
  })
