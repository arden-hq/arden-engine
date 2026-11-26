import { SESSION_FORK_DISPOSITION } from "@arden-hq/protocol/sessions"
import { Schema } from "effect"
import { type BranchOptions } from "../sessions/store.js"
import { sessionNameSchema } from "./session-rows.js"

export const BranchOptionsSchema = Schema.Struct({
  disposition: Schema.optionalKey(
    Schema.UndefinedOr(Schema.Literals(Object.values(SESSION_FORK_DISPOSITION)))
  ),
  name: Schema.optionalKey(Schema.UndefinedOr(sessionNameSchema)),
  upToMessageId: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
  requestId: Schema.optionalKey(Schema.UndefinedOr(Schema.NonEmptyString)),
  shareResources: Schema.optionalKey(Schema.UndefinedOr(Schema.Boolean))
})

export const branchRequest = (input: BranchOptions, sourceSessionId: string): string =>
  JSON.stringify({
    sourceSessionId,
    name: input.name ?? null,
    upToMessageId: input.upToMessageId ?? null,
    shareResources: input.shareResources === true,
    disposition: input.disposition ?? SESSION_FORK_DISPOSITION.retained
  })

export interface BranchSourceRow {
  readonly public_ref: string
  readonly name: string | null
  readonly space_id: string | null
  readonly metadata: string | null
  readonly source_policy_generation: number
}
