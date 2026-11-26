import { Effect, Schema } from "effect"
import {
  ToolExecutionStoreError,
  type ApprovalAlternativeInput,
  type ApprovalEditsInput,
  type ResolveToolApprovalInput
} from "../tools/store.js"
import type { StandingRuleList } from "@arden-hq/protocol/chat"
import { toolError } from "./tool-rows.js"
import type { ApprovalFolderResolutions } from "./tool-approval-folders.js"

const ResolveToolApprovalInputSchema = Schema.Struct({
  runId: Schema.NonEmptyString,
  toolCallId: Schema.NonEmptyString,
  approved: Schema.optionalKey(Schema.Boolean),
  feedback: Schema.optionalKey(Schema.String),
  grantStanding: Schema.optionalKey(Schema.Boolean),
  grantList: Schema.optionalKey(Schema.Literals(["space", "global"])),
  attachFolderToSpace: Schema.optionalKey(Schema.Boolean),
  askedAt: Schema.optionalKey(Schema.NonEmptyString),
  commandId: Schema.optionalKey(Schema.NonEmptyString)
})

export const decodeResolveInput = Effect.fn("SqliteToolExecutionStore.decodeResolveInput")(
  function* (input: ResolveToolApprovalInput): Effect.fn.Return<
    Required<Pick<ResolveToolApprovalInput, "runId" | "toolCallId" | "approved">> & {
      readonly feedback: string | null
      readonly grantStanding: boolean
      readonly grantList: StandingRuleList | undefined
      readonly attachFolderToSpace: boolean
      readonly edits: ApprovalEditsInput | null
      readonly alternative: ApprovalAlternativeInput | null
      readonly askedAt: string | undefined
      readonly commandId?: string
    },
    ToolExecutionStoreError
  > {
    const { edits, alternative, ...fields } = input
    const decoded = yield* Schema.decodeUnknownEffect(ResolveToolApprovalInputSchema)(fields, {
      onExcessProperty: "error"
    }).pipe(
      Effect.mapError((cause) =>
        toolError("resolve", "invalid", "Invalid tool approval decision", input, cause)
      )
    )
    if (decoded.approved === undefined) {
      return yield* toolError("resolve", "invalid", "Tool approval decision is required", decoded)
    }
    if (decoded.grantStanding === true && decoded.approved !== true) {
      return yield* toolError(
        "resolve",
        "invalid",
        "A standing permission requires approval",
        decoded
      )
    }
    if (decoded.grantList !== undefined && decoded.grantStanding !== true) {
      return yield* toolError(
        "resolve",
        "invalid",
        "Where to save names a standing permission",
        decoded
      )
    }
    if (decoded.attachFolderToSpace === true && decoded.approved !== true) {
      return yield* toolError(
        "resolve",
        "invalid",
        "Attaching a Local folder requires approval",
        decoded
      )
    }
    if (decoded.attachFolderToSpace === true && decoded.grantStanding === true) {
      return yield* toolError(
        "resolve",
        "invalid",
        "One approval cannot create two persistent grants",
        decoded
      )
    }
    if (edits !== undefined && decoded.approved !== true) {
      return yield* toolError("resolve", "invalid", "Edits on the card require approval", decoded)
    }
    if (
      alternative !== undefined &&
      (decoded.approved !== true ||
        decoded.grantStanding === true ||
        decoded.attachFolderToSpace === true)
    ) {
      return yield* toolError(
        "resolve",
        "invalid",
        "Save as draft is its own answer: it approves the draft and grants nothing",
        decoded
      )
    }
    const feedback = decoded.feedback?.trim() || null
    return {
      runId: decoded.runId,
      toolCallId: decoded.toolCallId,
      approved: decoded.approved,
      feedback,
      grantStanding: decoded.grantStanding === true,
      grantList: decoded.grantList,
      attachFolderToSpace: decoded.attachFolderToSpace === true,
      edits: edits ?? null,
      alternative: alternative ?? null,
      askedAt: decoded.askedAt,
      ...(decoded.commandId === undefined ? {} : { commandId: decoded.commandId })
    }
  }
)

export interface ToolApprovalResolveInput {
  readonly decision: Effect.Success<ReturnType<typeof decodeResolveInput>>
  readonly timestamp: string
  readonly approvedFolders: ApprovalFolderResolutions
}
